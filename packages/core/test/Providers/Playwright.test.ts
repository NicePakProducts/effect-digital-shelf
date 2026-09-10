import { describe, expect, it } from "@effect/vitest"
import * as Playwright from "@digital-shelf/core/Providers/Playwright"
import { ScrapeProviderError } from "@digital-shelf/core/Providers/ScrapeProviders"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import * as Browser from "../layers/Browser.ts"

const request = { url: "https://example.com/", country: Option.none() }
const fetchOnce = (
  browser: Browser.Scripted,
  deadline = Duration.seconds(30),
) =>
  Playwright.fetchOnce({
    binding: Browser.binding,
    launch: browser.launch,
    request,
    deadline,
  })

describe("Playwright provider — envelope", () => {
  it.effect("maps one navigation onto the settled envelope", () =>
    Effect.gen(function* () {
      const browser = Browser.scripted({
        sessionId: "session-42",
        finalUrl: "https://example.com/final",
        status: 201,
        responseHeaders: { "content-type": "text/html" },
        requestHeaders: { "user-agent": "Chrome/119" },
        cookies: [{ name: "smoke", value: "1" }],
        innerText: "Rendered text",
        userAgent: "Chrome/119 from the page",
        html: "<html><body>Rendered text</body></html>",
      })
      const { envelope, html } = yield* fetchOnce(browser)
      expect(envelope.finalUrl).toBe("https://example.com/final")
      expect(envelope.statusCode).toBe(201)
      expect(envelope.responseHeaders).toEqual({ "content-type": "text/html" })
      expect(envelope.cookies).toEqual([{ name: "smoke", value: "1" }])
      expect(envelope.innerText).toBe("Rendered text")
      expect(envelope.userAgent).toBe("Chrome/119 from the page")
      expect(envelope.type).toBe("html")
      expect(envelope.attempts).toBe(1)
      // Browser Rendering cannot observe the exit IP; the session is the
      // launched browser's (#18).
      expect(Option.isNone(envelope.ipInfo)).toBe(true)
      expect(envelope.session).toEqual(Option.some("session-42"))
      expect(html).toBe("<html><body>Rendered text</body></html>")
      // The forensic payload is the header pair, never the HTML.
      expect(envelope.raw).toEqual({
        requestHeaders: { "user-agent": "Chrome/119" },
        responseHeaders: { "content-type": "text/html" },
      })
      expect(JSON.stringify(envelope.raw)).not.toContain("Rendered text")
    }),
  )

  it.effect("reads the user agent from the page alone", () =>
    Effect.gen(function* () {
      // The in-page read is the one source: the request header is not a
      // second one (#18).
      const browser = Browser.scripted({
        userAgent: undefined,
        requestHeaders: { "user-agent": "Chrome/119" },
      })
      const { envelope } = yield* fetchOnce(browser)
      expect(envelope.userAgent).toBe("")
    }),
  )

  it.effect("keeps a non-JSON cookie payload out of the envelope", () =>
    Effect.gen(function* () {
      const browser = Browser.scripted({ cookies: [() => "not json"] })
      const { envelope } = yield* fetchOnce(browser)
      expect(envelope.cookies).toEqual([])
    }),
  )
})

describe("Playwright provider — classification", () => {
  const failing = (script: Browser.Script) =>
    Effect.flip(fetchOnce(Browser.scripted(script)))

  it.effect("a session that never launched is a retryable provider error", () =>
    Effect.gen(function* () {
      const error = yield* failing({ failLaunch: new Error("no session") })
      expect(error.code).toBe("provider_error")
      expect(error.retryable).toBe(true)
    }),
  )

  it.effect("Chrome's network errors are navigation failures", () =>
    Effect.gen(function* () {
      const error = yield* failing({
        failGoto: new Error(
          'page.goto: net::ERR_CONNECTION_RESET at https://nonexistent.invalid/\nCall log:\n  - navigating to "https://nonexistent.invalid/"',
        ),
      })
      expect(error.code).toBe("navigation_failed")
      expect(error.retryable).toBe(false)
      expect(error.message).toContain("ERR_CONNECTION_RESET")
    }),
  )

  it.effect("a URL Chrome refuses is an invalid URL", () =>
    Effect.gen(function* () {
      const error = yield* failing({
        failGoto: new Error("page.goto: Cannot navigate to invalid URL"),
      })
      expect(error.code).toBe("invalid_url")
    }),
  )

  it.effect("a blocked response is a block", () =>
    Effect.gen(function* () {
      const error = yield* failing({
        failGoto: new Error("page.goto: net::ERR_BLOCKED_BY_RESPONSE"),
      })
      expect(error.code).toBe("blocked")
      expect(error.retryable).toBe(false)
    }),
  )

  it.effect("a navigation with no response fails rather than half-maps", () =>
    Effect.gen(function* () {
      const error = yield* failing({ noResponse: true })
      expect(error.code).toBe("navigation_failed")
    }),
  )

  it.effect("a capture failure is a provider error, not a block", () =>
    Effect.gen(function* () {
      const error = yield* failing({
        failCapture: new Error("Target page has been closed"),
      })
      expect(error).toBeInstanceOf(ScrapeProviderError)
      expect(error.code).toBe("provider_error")
      expect(error.retryable).toBe(false)
    }),
  )
})

describe("Playwright provider — the session is always released", () => {
  it.effect("closes the browser after a successful navigation", () =>
    Effect.gen(function* () {
      const browser = Browser.scripted()
      yield* fetchOnce(browser)
      expect(browser.launched()).toBe(1)
      expect(browser.closed()).toBe(1)
    }),
  )

  it.effect("closes the browser when the navigation fails", () =>
    Effect.gen(function* () {
      const browser = Browser.scripted({
        failGoto: new Error("net::ERR_FAILED"),
      })
      yield* Effect.flip(fetchOnce(browser))
      expect(browser.closed()).toBe(1)
    }),
  )

  it.effect("closes the browser when the attempt deadline expires", () =>
    Effect.gen(function* () {
      const browser = Browser.scripted({ hang: true })
      const fiber = yield* Effect.flip(
        fetchOnce(browser, Duration.seconds(30)),
      ).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.seconds(31))
      const error = yield* Fiber.join(fiber)
      expect(error.code).toBe("navigation_failed")
      expect(error.message).toBe("Fetch attempt deadline exceeded")
      expect(browser.closed()).toBe(1)
    }),
  )

  it.effect("closes the browser when the caller is interrupted", () =>
    Effect.gen(function* () {
      const browser = Browser.scripted({ hang: true })
      const fiber = yield* fetchOnce(browser).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(1))
      yield* Fiber.interrupt(fiber)
      expect(browser.closed()).toBe(1)
    }),
  )
})
