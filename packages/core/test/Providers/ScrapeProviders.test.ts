import { describe, expect, it } from "@effect/vitest"
import * as Scrappey from "../../src/scrapes/providers/scrappey"
import { ScrapeProviders, layerWith } from "@app/core/scrapes/providers"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import * as Tracer from "effect/Tracer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as Browser from "../layers/Browser"
import * as Http from "../layers/HttpClient"
import success from "../fixtures/scrappey/success.json" with { type: "json" }

const request = {
  url: "https://www.example.com/product/1",
  country: Option.none<string>(),
}

/** The live service over a scripted browser and a canned HTTP fixture. */
const providers = (options: {
  readonly browser?: Browser.Script
  readonly respond?: (request: Http.Recorded) => Response | "never"
  readonly settings?: Record<string, string>
}) =>
  Effect.gen(function* () {
    const browser = Browser.scripted(options.browser ?? {})

    const http = yield* Http.respondingWith(
      options.respond ?? (() => Http.json(success)),
    )

    const service = yield* ScrapeProviders.Service.pipe(
      Effect.provide(
        layerWith({ launch: browser.launch }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Browser.TestLayer,
              Layer.succeed(HttpClient.HttpClient, http.client),
            ),
          ),
          Layer.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({
                SCRAPPEY_API_KEY: "scrappey-secret-key",
                ...options.settings,
              }),
            ),
          ),
        ),
      ),
    )

    return { service, browser, http }
  })

describe("ScrapeProviders — the mode picks the provider", () => {
  it.effect("basic goes to Browser Rendering", () =>
    Effect.gen(function* () {
      const { service, browser, http } = yield* providers({})
      const { envelope } = yield* service.fetch("basic", request)
      expect(browser.launched()).toBe(1)
      expect(yield* http.requests).toEqual([])
      expect(Option.isNone(envelope.ipInfo)).toBe(true)
    }),
  )

  it.effect("advance goes to Scrappey with the country", () =>
    Effect.gen(function* () {
      const { service, browser, http } = yield* providers({})

      const { envelope } = yield* service.fetch("advance", {
        url: request.url,
        country: Option.some("Australia"),
      })

      expect(browser.launched()).toBe(0)
      const [sent] = yield* http.requests
      expect(sent?.url).toContain(Scrappey.ENDPOINT)
      expect(JSON.parse(sent?.body ?? "{}").proxyCountry).toBe("Australia")
      expect(Option.isSome(envelope.ipInfo)).toBe(true)
    }),
  )
})

describe("ScrapeProviders — Fetch attempts", () => {
  it.effect("retries are off by default", () =>
    Effect.gen(function* () {
      const { service, http } = yield* providers({
        respond: () => Http.json({ data: "error", error: "CODE-0001" }),
      })

      const error = yield* Effect.flip(service.fetch("advance", request))
      expect(error.retryable).toBe(true)
      expect(error.attempts).toBe(1)
      expect((yield* http.requests).length).toBe(1)
    }),
  )

  it.effect("a retryable failure is retried up to the configured cap", () =>
    Effect.gen(function* () {
      const { service, http } = yield* providers({
        respond: () => Http.json({ data: "error", error: "CODE-0001" }),
        settings: {
          SCRAPPEY_MAX_ATTEMPTS: "3",
          SCRAPPEY_RETRY_BASE_DELAY: "10 millis",
        },
      })

      const fiber = yield* Effect.flip(service.fetch("advance", request)).pipe(
        Effect.forkChild,
      )

      yield* TestClock.adjust(Duration.seconds(1))
      const error = yield* Fiber.join(fiber)
      expect(error.attempts).toBe(3)
      expect((yield* http.requests).length).toBe(3)
    }),
  )

  it.effect("a block is never retried, however high the cap", () =>
    Effect.gen(function* () {
      const { service, http } = yield* providers({
        respond: () =>
          Http.json({ data: "error", error: "CODE-0002 verification failed" }),
        settings: {
          SCRAPPEY_MAX_ATTEMPTS: "5",
          SCRAPPEY_RETRY_BASE_DELAY: "10 millis",
        },
      })

      const error = yield* Effect.flip(service.fetch("advance", request))
      expect(error.code).toBe("blocked")
      expect(error.attempts).toBe(1)
      expect((yield* http.requests).length).toBe(1)
    }),
  )

  it.effect("the envelope carries the attempts a success actually took", () =>
    Effect.gen(function* () {
      let calls = 0

      const { service } = yield* providers({
        respond: () => {
          calls += 1

          return calls === 1
            ? Http.json({ data: "error", error: "CODE-0001" })
            : Http.json(success)
        },
        settings: {
          SCRAPPEY_MAX_ATTEMPTS: "2",
          SCRAPPEY_RETRY_BASE_DELAY: "10 millis",
        },
      })

      const fiber = yield* service
        .fetch("advance", request)
        .pipe(Effect.forkChild)

      yield* TestClock.adjust(Duration.seconds(1))
      const { envelope } = yield* Fiber.join(fiber)
      expect(envelope.attempts).toBe(2)
    }),
  )

  it.effect("a session failure is retried, a browser block is not", () =>
    Effect.gen(function* () {
      const retried = yield* providers({
        browser: { failLaunch: new Error("no session") },
        settings: {
          BROWSER_MAX_ATTEMPTS: "2",
          BROWSER_RETRY_BASE_DELAY: "10 millis",
        },
      })

      const fiber = yield* Effect.flip(
        retried.service.fetch("basic", request),
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust(Duration.seconds(1))
      expect((yield* Fiber.join(fiber)).attempts).toBe(2)

      const blocked = yield* providers({
        browser: { failGoto: new Error("net::ERR_BLOCKED_BY_RESPONSE") },
        settings: {
          BROWSER_MAX_ATTEMPTS: "2",
          BROWSER_RETRY_BASE_DELAY: "10 millis",
        },
      })

      const error = yield* Effect.flip(blocked.service.fetch("basic", request))
      expect(error.code).toBe("blocked")
      expect(error.attempts).toBe(1)
    }),
  )
})

describe("ScrapeProviders — spans", () => {
  const recording = <A, E, R>(work: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const base = yield* Tracer.Tracer
      const spans: Tracer.Span[] = []

      const tracer = Tracer.make({
        span(options) {
          const span = base.span(options)
          spans.push(span)

          return span
        },
      })

      yield* work.pipe(Effect.withTracer(tracer))

      return spans
    })

  it.effect("a fetch span names the provider, attempt and envelope", () =>
    Effect.gen(function* () {
      const { service } = yield* providers({
        browser: { html: "<html><body>secret markup</body></html>" },
      })

      const spans = yield* recording(service.fetch("basic", request))

      const attempt = spans.find(
        (span) => span.name === "ScrapeProviders.browser",
      )

      expect(attempt?.attributes.get("shelf.provider")).toBe("browser")
      expect(attempt?.attributes.get("shelf.attempt")).toBe(1)
      expect(attempt?.attributes.get("shelf.envelope.type")).toBe("html")
      expect(attempt?.attributes.get("shelf.envelope.status_code")).toBe(200)
      const fetch = spans.find((span) => span.name === "ScrapeProviders.fetch")
      expect(fetch?.attributes.get("shelf.provider")).toBe("browser")
      expect(fetch?.attributes.get("shelf.attempts")).toBe(1)
      expect(fetch?.attributes.get("shelf.envelope.type")).toBe("html")

      for (const span of spans)
        for (const value of span.attributes.values())
          expect(String(value)).not.toContain("secret markup")
    }),
  )

  it.effect("a failed fetch span names the error code", () =>
    Effect.gen(function* () {
      const { service } = yield* providers({
        browser: { failGoto: new Error("net::ERR_CONNECTION_RESET") },
      })

      const spans = yield* recording(
        Effect.flip(service.fetch("basic", request)),
      )

      const fetch = spans.find((span) => span.name === "ScrapeProviders.fetch")
      expect(fetch?.attributes.get("shelf.error.code")).toBe(
        "navigation_failed",
      )
      expect(fetch?.attributes.get("shelf.provider")).toBe("browser")

      const attempt = spans.find(
        (span) => span.name === "ScrapeProviders.browser",
      )

      expect(attempt?.attributes.get("shelf.error.code")).toBe(
        "navigation_failed",
      )
    }),
  )
})
