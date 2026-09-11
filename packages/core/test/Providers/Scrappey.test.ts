import { describe, expect, it } from "@effect/vitest"
import * as Scrappey from "@digital-shelf/core/Providers/Scrappey"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as TestClock from "effect/testing/TestClock"
import * as Tracer from "effect/Tracer"
import blocked from "../fixtures/scrappey/blocked.json" with { type: "json" }
import invalidUrl from "../fixtures/scrappey/invalid-url.json" with { type: "json" }
import noPage from "../fixtures/scrappey/no-page.json" with { type: "json" }
import overloaded from "../fixtures/scrappey/overloaded.json" with { type: "json" }
import success from "../fixtures/scrappey/success.json" with { type: "json" }
import * as Http from "../layers/HttpClient.ts"

const KEY = Redacted.make("scrappey-secret-key")

const request = {
  url: "https://www.example.com/product/1",
  country: Option.none<string>(),
}

const against = (
  respond: (request: Http.Recorded) => Response | "never" | "unreachable",
  overrides: {
    readonly request?: typeof request
    readonly deadline?: Duration.Duration
  } = {},
) =>
  Effect.gen(function* () {
    const fixture = yield* Http.respondingWith(respond)

    return {
      fixture,
      fetch: Scrappey.fetchOnce({
        client: Scrappey.clientFor(fixture.client, KEY),
        endpoint: Scrappey.ENDPOINT,
        request: overrides.request ?? request,
        deadline: overrides.deadline ?? Duration.seconds(30),
      }),
    }
  })

describe("Scrappey provider — the call", () => {
  it.effect("posts request.get with the key in the query string", () =>
    Effect.gen(function* () {
      const { fixture, fetch } = yield* against(() => Http.json(success))
      yield* fetch
      const [sent] = yield* fixture.requests
      expect(sent?.method).toBe("POST")
      expect(sent?.url).toBe(`${Scrappey.ENDPOINT}?key=scrappey-secret-key`)
      expect(JSON.parse(sent?.body ?? "{}")).toEqual({
        cmd: "request.get",
        url: request.url,
      })
    }),
  )

  it.effect("sends the country only in advance mode's request", () =>
    Effect.gen(function* () {
      const { fixture, fetch } = yield* against(() => Http.json(success), {
        request: { url: request.url, country: Option.some("Australia") },
      })

      yield* fetch
      const [sent] = yield* fixture.requests
      expect(JSON.parse(sent?.body ?? "{}").proxyCountry).toBe("Australia")
    }),
  )
})

describe("Scrappey provider — envelope", () => {
  it.effect("maps the success fixture onto the settled envelope", () =>
    Effect.gen(function* () {
      const { fetch } = yield* against(() => Http.json(success))
      const { envelope, html } = yield* fetch
      expect(envelope.finalUrl).toBe(
        "https://www.example.com/product/1?ref=redirect",
      )
      expect(envelope.statusCode).toBe(200)
      expect(envelope.responseHeaders).toEqual(success.solution.responseHeaders)
      expect(envelope.cookies).toEqual(success.solution.cookies)
      expect(envelope.innerText).toBe("Widget  A$9.99  In stock")
      expect(envelope.userAgent).toBe(success.solution.userAgent)
      expect(envelope.type).toBe("html")
      expect(envelope.attempts).toBe(1)
      // Scrappey is the mode that can see the exit IP and names the session.
      expect(envelope.ipInfo).toEqual(Option.some(success.solution.ipInfo))
      expect(envelope.session).toEqual(Option.some(success.session))
      expect(html).toBe(success.solution.response)
      // `raw` is the whole vendor payload with the HTML stripped (#13):
      // fields this client never reads still reach the forensic record.
      expect(JSON.stringify(envelope.raw)).not.toContain("<html>")
      const { response: _html, ...solution } = success.solution
      expect(envelope.raw).toEqual({ ...success, solution })
    }),
  )

  it.effect("keeps vendor fields it does not model in `raw`", () =>
    Effect.gen(function* () {
      const { fetch } = yield* against(() =>
        Http.json({
          ...success,
          solution: {
            ...success.solution,
            fingerprint: { vendor: "extension" },
          },
          creditsLeft: 41,
        }),
      )

      const { envelope } = yield* fetch

      const raw = Schema.decodeUnknownSync(
        Schema.Struct({
          creditsLeft: Schema.Number,
          solution: Schema.Record(Schema.String, Schema.Json),
        }),
      )(envelope.raw)

      expect(raw.creditsLeft).toBe(41)
      expect(raw.solution.fingerprint).toEqual({ vendor: "extension" })
      expect(raw.solution.verified).toBe(true)
      expect(raw.solution).not.toHaveProperty("response")
    }),
  )

  it.effect("fills the gaps a thin solution leaves rather than failing", () =>
    Effect.gen(function* () {
      const { fetch } = yield* against(() =>
        Http.json({
          data: "success",
          solution: { statusCode: 200, response: "<html></html>" },
        }),
      )

      const { envelope } = yield* fetch
      expect(envelope.finalUrl).toBe(request.url)
      expect(envelope.statusCode).toBe(200)
      expect(envelope.responseHeaders).toEqual({})
      expect(Option.isNone(envelope.ipInfo)).toBe(true)
      expect(Option.isNone(envelope.session)).toBe(true)
    }),
  )
})

describe("Scrappey provider — classification", () => {
  const failing = (
    respond: (request: Http.Recorded) => Response | "never" | "unreachable",
  ) => Effect.flatMap(against(respond), ({ fetch }) => Effect.flip(fetch))

  it.effect("an unreachable Scrappey is a retryable provider error", () =>
    Effect.gen(function* () {
      const error = yield* failing(() => "unreachable")
      expect(error.code).toBe("provider_error")
      expect(error.retryable).toBe(true)
      expect(error.detail).toEqual({ reason: "TransportError" })
    }),
  )

  it.effect("a verification code is a block, and never retried", () =>
    Effect.gen(function* () {
      const error = yield* failing(() => Http.json(blocked))
      expect(error.code).toBe("blocked")
      expect(error.retryable).toBe(false)
      expect(error.message).toContain("CODE-0002")
    }),
  )

  it.effect("an overloaded server is a retryable provider error", () =>
    Effect.gen(function* () {
      const error = yield* failing(() => Http.json(overloaded))
      expect(error.code).toBe("provider_error")
      expect(error.retryable).toBe(true)
    }),
  )

  it.effect("a rejected URL is an invalid URL", () =>
    Effect.gen(function* () {
      const error = yield* failing(() => Http.json(invalidUrl))
      expect(error.code).toBe("invalid_url")
      expect(error.retryable).toBe(false)
    }),
  )

  it.effect("a solution without a page is a provider error", () =>
    Effect.gen(function* () {
      const error = yield* failing(() => Http.json(noPage))
      expect(error.code).toBe("provider_error")
      expect(error.message).toContain("without a rendered page")
    }),
  )

  it.effect("a solution without a status code is a provider error", () =>
    Effect.gen(function* () {
      const error = yield* failing(() =>
        Http.json({ data: "success", solution: { response: "<html></html>" } }),
      )

      expect(error.code).toBe("provider_error")
      expect(error.retryable).toBe(false)
      expect(error.message).toContain("without a status code")
    }),
  )

  it.effect("a body this client cannot read is a provider error", () =>
    Effect.gen(function* () {
      const error = yield* failing(
        () => new Response("<html>not json</html>", { status: 200 }),
      )

      expect(error.code).toBe("provider_error")
      expect(error.retryable).toBe(false)
      expect(error.message).toContain("cannot read")
    }),
  )

  it.effect("a solution of the wrong shape is a provider error", () =>
    Effect.gen(function* () {
      const error = yield* failing(() =>
        Http.json({ data: "success", solution: { statusCode: "200" } }),
      )

      expect(error.code).toBe("provider_error")
      expect(error.message).toContain("cannot read")
    }),
  )

  it.effect("Scrappey's own 429 and 500 are retryable, its 401 is not", () =>
    Effect.gen(function* () {
      for (const [status, retryable] of [
        [429, true],
        [503, true],
        [401, false],
        [403, false],
      ] as const) {
        const error = yield* failing(() => Http.json({}, status))
        expect(error.code).toBe("provider_error")
        expect(error.retryable).toBe(retryable)
        expect(error.message).toContain(String(status))
      }
    }),
  )

  it.effect("the attempt deadline is a navigation failure", () =>
    Effect.gen(function* () {
      const { fetch } = yield* against(() => "never", {
        deadline: Duration.seconds(30),
      })

      const fiber = yield* Effect.flip(fetch).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(31))
      const error = yield* Fiber.join(fiber)
      expect(error.code).toBe("navigation_failed")
      expect(error.message).toBe("Fetch attempt deadline exceeded")
    }),
  )
})

describe("Scrappey provider — the key and the trace stay put", () => {
  it.effect("no traceparent leaves for the third party", () =>
    Effect.gen(function* () {
      const { fixture, fetch } = yield* against(() => Http.json(success))
      yield* fetch.pipe(Effect.withSpan("test.parent"))
      const [sent] = yield* fixture.requests
      expect(Object.keys(sent?.headers ?? {})).not.toContain("traceparent")
      expect(Object.keys(sent?.headers ?? {})).not.toContain("b3")
    }),
  )

  it.effect("a transport failure's message carries no API key", () =>
    Effect.gen(function* () {
      const { fetch } = yield* against(() => "unreachable")
      const error = yield* Effect.flip(fetch)
      expect(error.message).not.toContain(Redacted.value(KEY))
      expect(JSON.stringify(error.detail)).not.toContain(Redacted.value(KEY))
    }),
  )

  it.effect("the client span carries no API key", () =>
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

      const { fetch } = yield* against(() => Http.json(success))
      yield* fetch.pipe(Effect.withTracer(tracer))
      const client = spans.filter((span) => span.name.startsWith("http.client"))
      // The local client span is kept (#28); only the key is withheld.
      expect(client.length).toBe(1)

      for (const span of spans)
        for (const value of span.attributes.values())
          expect(String(value)).not.toContain(Redacted.value(KEY))
    }),
  )
})
