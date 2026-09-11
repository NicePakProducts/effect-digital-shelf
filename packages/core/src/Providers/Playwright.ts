import type { ScrapeEnvelope } from "@digital-shelf/domain/Scraping/ScrapeEnvelope"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"
import type { BrowserBinding } from "./BrowserRendering.ts"
import {
  ScrapeProviderError,
  type ScrapeRequest,
  type ScrapeResult,
} from "./ScrapeProviders.ts"

/**
 * `basic` mode: one navigation over Cloudflare Browser Rendering with
 * Playwright, collecting every field the Scrape envelope needs in a single
 * page load (#13, smoke #18). The runner owns the Scrape deadline, the
 * inner-text cap and the R2 puts; this module navigates, builds the envelope
 * and classifies its own failures before they cross the step boundary.
 *
 * `ipInfo` is `None` here — Playwright cannot observe the exit IP — and
 * `session` is the Browser Rendering session id.
 */

/**
 * The slice of Playwright this module drives, named structurally so the test
 * layer can script a browser without the library and so the one cast the
 * real `launch` needs stays in `launchOnWorkerd` below.
 */
export interface PageResponse {
  readonly status: () => number
  readonly allHeaders: () => Promise<Record<string, string>>
  readonly request: () => {
    readonly allHeaders: () => Promise<Record<string, string>>
  }
}

export interface Page {
  readonly goto: (
    url: string,
    options: { readonly waitUntil: "load"; readonly timeout: number },
  ) => Promise<PageResponse | null>
  readonly url: () => string
  readonly innerText: (selector: string) => Promise<string>
  /**
   * Called with a source string, never a function: Alchemy's bundler defines
   * `navigator.userAgent` as `"Cloudflare-Workers"` at build time, so a
   * function body would be rewritten before Playwright serialised it (#18).
   */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Playwright string evaluate returns unknown; the capture boundary decodes it.
  readonly evaluate: (expression: string) => Promise<unknown>
  readonly content: () => Promise<string>
}

/** The cookie record `BrowserContext.cookies` resolves, as Playwright types it. */
export type Cookie = {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  /** Unix time in seconds. */
  readonly expires: number
  readonly httpOnly: boolean
  readonly secure: boolean
  readonly sameSite: "Strict" | "Lax" | "None"
  readonly partitionKey?: string
}

export interface BrowserContext {
  readonly newPage: () => Promise<Page>
  readonly cookies: () => Promise<ReadonlyArray<Cookie>>
}

export interface Browser {
  readonly newContext: () => Promise<BrowserContext>
  readonly sessionId: () => string
  readonly close: () => Promise<void>
}

export type Launch = (binding: BrowserBinding) => Promise<Browser>

/**
 * Deferred import: `@cloudflare/playwright` imports `cloudflare:workers` at
 * module top level, and Alchemy evaluates the Worker and Workflow init graph
 * in Node at deploy time, where a static import fails the deploy with
 * "Received protocol 'cloudflare:'" (#18). The cast bridging the library's
 * `BrowserWorker` parameter to the platform binding lives here,
 * once, and nowhere else in core.
 */
export const launchOnWorkerd: Launch = async (binding) => {
  const playwright = await import("@cloudflare/playwright")

  // SAFETY: The platform supplies the Browser Rendering fetch binding; only the incompatible DOM and Workers fetch declarations differ.
  return playwright.launch(binding as Parameters<typeof playwright.launch>[0])
}

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

type Phase = "session" | "navigate" | "capture"

/**
 * Chrome's own diagnostics are the only signal here, so the sniffing table
 * stays in this module and the runner switches on `code` alone (#13).
 */
export const classify = (
  phase: Phase,
  cause: unknown,
): Pick<ScrapeProviderError, "code" | "retryable"> => {
  const message = messageOf(cause)

  // A session that never launched is the provider failing, not the target.
  if (phase === "session") return { code: "provider_error", retryable: true }

  if (
    /invalid URL|Protocol ".+" not supported|unsupported protocol/i.test(
      message,
    )
  )
    return { code: "invalid_url", retryable: false }

  if (/ERR_BLOCKED_BY_(CLIENT|RESPONSE)|ERR_ACCESS_DENIED/i.test(message))
    return { code: "blocked", retryable: false }

  if (/net::ERR_|Timeout .* exceeded|navigating to |ERR_ABORTED/i.test(message))
    return { code: "navigation_failed", retryable: false }

  return { code: "provider_error", retryable: false }
}

const failure = (phase: Phase, cause: unknown) =>
  new ScrapeProviderError({
    ...classify(phase, cause),
    message: messageOf(cause),
    // Stamped by the caller, which owns the attempt count.
    attempts: 1,
    detail: { phase },
  })

const step = <A>(phase: Phase, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(phase, cause) })

/**
 * One Fetch attempt. The browser session is acquired in a scope so a session
 * this module obtained is released on failure and on interruption alike; a
 * Scrape that runs out of deadline must not leave a session open. The launch
 * itself stays interruptible so the attempt deadline and the runner's Scrape
 * deadline can fire while Browser Rendering is still acquiring: a launch
 * that resolves after that interruption is not ours to close, and Browser
 * Rendering reaps it at its own session expiry.
 */
export const fetchOnce = (options: {
  readonly binding: BrowserBinding
  readonly launch: Launch
  readonly request: ScrapeRequest
  readonly deadline: Duration.Duration
}): Effect.Effect<ScrapeResult, ScrapeProviderError> =>
  Effect.gen(function* () {
    const browser = yield* Effect.acquireRelease(
      step("session", () => options.launch(options.binding)),
      (browser) =>
        Effect.tryPromise({
          try: () => browser.close(),
          catch: (cause) => cause,
        }).pipe(Effect.ignore),
      { interruptible: true },
    )

    const context = yield* step("session", () => browser.newContext())
    const page = yield* step("session", () => context.newPage())

    const response = yield* step("navigate", () =>
      page.goto(options.request.url, {
        waitUntil: "load",
        timeout: Duration.toMillis(options.deadline),
      }),
    )

    if (response === null)
      return yield* Effect.fail(
        new ScrapeProviderError({
          code: "navigation_failed",
          retryable: false,
          message: "Navigation produced no response",
          attempts: 1,
          detail: { phase: "navigate" },
        }),
      )
    const statusCode = response.status()
    const responseHeaders = yield* step("capture", () => response.allHeaders())

    const requestHeaders = yield* step("capture", () =>
      response.request().allHeaders(),
    )

    const cookies = yield* step("capture", () => context.cookies())
    const innerText = yield* step("capture", () => page.innerText("body"))

    // A string expression, never a function: see `Page.evaluate` above.
    const userAgent = yield* step("capture", () =>
      page.evaluate("navigator.userAgent"),
    )

    const html = yield* step("capture", () => page.content())

    const envelope: ScrapeEnvelope = {
      finalUrl: page.url(),
      statusCode,
      responseHeaders,
      cookies,
      innerText,
      userAgent: Schema.decodeUnknownOption(Schema.String)(userAgent).pipe(
        Option.getOrElse(() => ""),
      ),
      ipInfo: Option.none(),
      type: "html",
      session: Option.some(browser.sessionId()),
      // Playwright returns no vendor payload; the header pair is the
      // forensic record, and never the HTML (#18).
      raw: { requestHeaders, responseHeaders },
      attempts: 1,
    }

    return { envelope, html }
  }).pipe(
    Effect.scoped,
    Effect.timeout(options.deadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        new ScrapeProviderError({
          code: "navigation_failed",
          retryable: false,
          message: "Fetch attempt deadline exceeded",
          attempts: 1,
          detail: { phase: "navigate" },
        }),
      ),
    ),
  )
