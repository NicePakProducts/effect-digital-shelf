import type { BrowserWorker } from "@cloudflare/playwright"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

export class FetchFailure extends Data.TaggedError("FetchFailure")<{
  readonly message: string
  readonly stack?: string
}> {}

/**
 * Alchemy hands the binding over as workers-types' `BrowserRun`, whose
 * `fetch` takes a `Request<unknown, CfProperties>`; Playwright's
 * `BrowserWorker` wants lib.dom's `typeof fetch`. Same object at runtime,
 * so the cast lives here, once.
 */
export interface BrowserBindingLike {
  readonly fetch: (input: never, init?: never) => Promise<unknown>
}

/**
 * One navigation over Browser Rendering with Playwright, collecting every
 * field the Scrape envelope needs (#13). HTML and innerText are reported by
 * length plus a head so the step output stays far below the 1 MiB cap.
 */
export const fetchEnvelope = (binding: BrowserBindingLike, url: string) =>
  Effect.tryPromise({
    try: async () => {
      // Deferred: `@cloudflare/playwright` imports `cloudflare:workers` at
      // module top level, and Alchemy evaluates this module in Node at
      // deploy time (the Effect-form Worker's init phase). A static import
      // fails the deploy with "Received protocol 'cloudflare:'".
      const { launch } = await import("@cloudflare/playwright")
      const t0 = Date.now()
      const browser = await launch(binding as unknown as BrowserWorker, {
        keep_alive: 30_000,
      })
      const tLaunch = Date.now()
      try {
        const context = await browser.newContext()
        const page = await context.newPage()
        const response = await page.goto(url, {
          waitUntil: "load",
          timeout: 30_000,
        })
        const tNav = Date.now()
        const finalUrl = page.url()
        const statusCode = response ? response.status() : null
        const responseHeaders = response ? await response.allHeaders() : {}
        const cookies = await context.cookies()
        const innerText = await page.innerText("body")
        // Two probes: an arrow function (serialised by Playwright and sent
        // to Chrome) and a string expression (unambiguously evaluated in the
        // page). Plus the headers Chrome actually sent, from the request.
        const userAgentArrow = await page.evaluate(() => navigator.userAgent)
        const userAgentExpr = (await page.evaluate("navigator.userAgent")) as string
        const requestHeaders = response ? await response.request().allHeaders() : {}
        const html = await page.content()
        const tDone = Date.now()
        return {
          finalUrl,
          statusCode,
          responseHeaders,
          cookies,
          innerTextLength: innerText.length,
          innerTextHead: innerText.slice(0, 200),
          userAgent: userAgentExpr,
          userAgentArrow,
          requestHeaders,
          htmlLength: html.length,
          htmlHead: html.slice(0, 200),
          sessionId: browser.sessionId(),
          timings: {
            launchMs: tLaunch - t0,
            navigateMs: tNav - tLaunch,
            extractMs: tDone - tNav,
            totalMs: tDone - t0,
          },
        }
      } finally {
        await browser.close()
      }
    },
    catch: (cause) =>
      new FetchFailure({
        message: cause instanceof Error ? cause.message : String(cause),
        ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
      }),
  })

export type Envelope = Effect.Success<ReturnType<typeof fetchEnvelope>>
