import * as Context from "effect/Context"

/**
 * The Browser Rendering binding, as a value core holds rather than a vendor
 * SDK it constructs. `apps/server` resolves Alchemy's `Cloudflare.Browser`
 * in its Worker or Workflow init phase and hands the raw binding over
 * (#22, ADR 0006); core never imports Alchemy.
 *
 * The shape is structural on purpose (#18): Alchemy types the binding as
 * workers-types' `BrowserRun` and Playwright's `launch` wants lib.dom's
 * `BrowserWorker`. Neither assigns to the other, but both satisfy this, so
 * the call site needs no cast and Providers/Playwright.ts carries the one
 * cast the library demands.
 */
export interface BrowserBinding {
  readonly fetch: (input: never, init?: never) => Promise<unknown>
}

export class BrowserRendering extends Context.Service<
  BrowserRendering,
  BrowserBinding
>()("@digital-shelf/core/Providers/BrowserRendering") {}
