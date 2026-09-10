import {
  BrowserRendering,
  type BrowserBinding,
} from "@digital-shelf/core/Providers/BrowserRendering"
import type {
  Browser,
  BrowserContext,
  Cookie,
  Launch,
  Page,
  PageResponse,
} from "@digital-shelf/core/Providers/Playwright"
import * as Layer from "effect/Layer"

/**
 * A scripted Playwright browser: the provider drives the same structural
 * surface the real library satisfies, so the mapping, the classification
 * table and the session release can be exercised without Browser Rendering.
 */
export interface Script {
  readonly sessionId?: string
  readonly finalUrl?: string
  readonly status?: number
  readonly responseHeaders?: Record<string, string>
  readonly requestHeaders?: Record<string, string>
  readonly cookies?: ReadonlyArray<Cookie>
  readonly innerText?: string
  readonly userAgent?: unknown
  readonly html?: string
  /** `null` reproduces a navigation that yielded no response. */
  readonly noResponse?: boolean
  /** Thrown from `launch`, `goto` or `content` respectively. */
  readonly failLaunch?: unknown
  readonly failGoto?: unknown
  readonly failCapture?: unknown
  /** Leaves `goto` pending forever, so the caller must time out. */
  readonly hang?: boolean
  /** Leaves `launch` pending forever: Browser Rendering never answers. */
  readonly hangLaunch?: boolean
}

export interface Scripted {
  readonly launch: Launch
  /** Sessions launched and sessions closed, to prove release runs. */
  readonly launched: () => number
  readonly closed: () => number
}

const rejection = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause))

export const scripted = (script: Script = {}): Scripted => {
  let launched = 0
  let closed = 0
  const response: PageResponse = {
    status: () => script.status ?? 200,
    allHeaders: () => Promise.resolve(script.responseHeaders ?? {}),
    request: () => ({
      allHeaders: () => Promise.resolve(script.requestHeaders ?? {}),
    }),
  }
  const page: Page = {
    goto: () => {
      if (script.failGoto !== undefined)
        return Promise.reject(rejection(script.failGoto))
      if (script.hang === true) return new Promise<never>(() => {})
      return Promise.resolve(script.noResponse === true ? null : response)
    },
    url: () => script.finalUrl ?? "https://example.com/",
    innerText: () => Promise.resolve(script.innerText ?? "Hello"),
    evaluate: () =>
      script.failCapture !== undefined
        ? Promise.reject(rejection(script.failCapture))
        : Promise.resolve(
            Object.hasOwn(script, "userAgent")
              ? script.userAgent
              : "TestAgent/1.0",
          ),
    content: () =>
      Promise.resolve(script.html ?? "<html><body>Hello</body></html>"),
  }
  const context: BrowserContext = {
    newPage: () => Promise.resolve(page),
    cookies: () => Promise.resolve(script.cookies ?? []),
  }
  const browser: Browser = {
    newContext: () => Promise.resolve(context),
    sessionId: () => script.sessionId ?? "session-1",
    close: () => {
      closed += 1
      return Promise.resolve()
    },
  }
  return {
    launch: () => {
      if (script.failLaunch !== undefined)
        return Promise.reject(rejection(script.failLaunch))
      if (script.hangLaunch === true) return new Promise<never>(() => {})
      launched += 1
      return Promise.resolve(browser)
    },
    launched: () => launched,
    closed: () => closed,
  }
}

/** The binding value itself is never called: Playwright owns the transport. */
export const binding: BrowserBinding = {
  fetch: () => Promise.reject(new Error("binding.fetch is not used in tests")),
}

export const layerTest = Layer.succeed(BrowserRendering, binding)
