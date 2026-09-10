import type { ScrapeEnvelope } from "@digital-shelf/domain/Scraping/ScrapeEnvelope"
import type { ScrapeMode } from "@digital-shelf/domain/Scraping/Vocabulary"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schedule from "effect/Schedule"
import * as HttpClient from "effect/unstable/http/HttpClient"
import { BrowserRendering } from "./BrowserRendering.ts"
import * as Playwright from "./Playwright.ts"
import * as Scrappey from "./Scrappey.ts"

/**
 * The one question the lifecycle asks of the outside world: fetch this URL
 * in this mode. The Browser Rendering and Scrappey modules behind the live
 * layer are internal to core (map ticket "Scrape providers as Effect
 * services"); the runner switches on `code` only. `timeout` and
 * `parent_deleted` are core's own codes, never a provider's.
 */

export const ScrapeProviderErrorCodes = [
  "navigation_failed",
  "blocked",
  "provider_error",
  "invalid_url",
] as const
export type ScrapeProviderErrorCode = (typeof ScrapeProviderErrorCodes)[number]

export class ScrapeProviderError extends Data.TaggedError(
  "ScrapeProviderError",
)<{
  readonly code: ScrapeProviderErrorCode
  readonly retryable: boolean
  readonly message: string
  /** Fetch attempts made before giving up. */
  readonly attempts: number
  readonly detail?: unknown
}> {}

export interface ScrapeRequest {
  readonly url: string
  /** Only meaningful in `advance` mode. */
  readonly country: Option.Option<string>
}

export interface ScrapeResult {
  readonly envelope: ScrapeEnvelope
  /** The captured HTML, beside the envelope and never inside it. */
  readonly html: string
}

export class ScrapeProviders extends Context.Service<
  ScrapeProviders,
  {
    readonly fetch: (
      mode: ScrapeMode,
      request: ScrapeRequest,
    ) => Effect.Effect<ScrapeResult, ScrapeProviderError>
  }
>()("@digital-shelf/core/Providers/ScrapeProviders") {}

/**
 * The live service. `basic` goes to Browser Rendering, `advance` to
 * Scrappey; both spend from the same Scrape deadline the runner applies
 * around this call, so the per-attempt deadline and the retry budget are
 * bounded knobs inside it, not a second budget beside it (#13).
 */
export interface RetryPolicy {
  /** 1 means no retry: the default for both providers. */
  readonly maxAttempts: number
  readonly baseDelay: Duration.Duration
  readonly maxDelay: Duration.Duration
}

const policy = (prefix: string) =>
  Config.all({
    maxAttempts: Config.int(`${prefix}_MAX_ATTEMPTS`).pipe(
      Config.withDefault(1),
    ),
    baseDelay: Config.duration(`${prefix}_RETRY_BASE_DELAY`).pipe(
      Config.withDefault(Duration.seconds(1)),
    ),
    maxDelay: Config.duration(`${prefix}_RETRY_MAX_DELAY`).pipe(
      Config.withDefault(Duration.seconds(8)),
    ),
  })

/**
 * Counts the Fetch attempts a Scrape actually made and stamps the count on
 * whichever outcome it reaches, so the envelope and the error agree with the
 * row the runner writes. Each attempt gets its own span, and neither it nor
 * the surrounding fetch span ever carries the HTML (#28).
 */
const attempted = (
  provider: "browser" | "scrappey",
  retry: RetryPolicy,
  once: Effect.Effect<ScrapeResult, ScrapeProviderError>,
) =>
  Effect.gen(function* () {
    const counter = yield* Ref.make(0)
    const attempt = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(counter, (made) => made + 1)
      return yield* once.pipe(
        Effect.tap((result) =>
          Effect.annotateCurrentSpan({
            "shelf.envelope.type": result.envelope.type,
            "shelf.envelope.status_code": result.envelope.statusCode,
          }),
        ),
        Effect.tapError((error) =>
          Effect.annotateCurrentSpan("shelf.error.code", error.code),
        ),
        Effect.withSpan(`ScrapeProviders.${provider}`, {
          attributes: { "shelf.provider": provider, "shelf.attempt": n },
        }),
      )
    })
    return yield* attempt.pipe(
      Effect.retry(
        Schedule.exponential(retry.baseDelay).pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, retry.maxDelay)),
          ),
          Schedule.while(
            ({
              attempt: recurrence,
              input,
            }: Schedule.Metadata<Duration.Duration, ScrapeProviderError>) =>
              recurrence < retry.maxAttempts && input.retryable,
          ),
        ),
      ),
      Effect.matchEffect({
        onFailure: (error: ScrapeProviderError) =>
          Effect.flatMap(Ref.get(counter), (attempts) =>
            Effect.andThen(
              Effect.annotateCurrentSpan({
                "shelf.error.code": error.code,
                "shelf.attempts": attempts,
              }),
              Effect.fail(
                new ScrapeProviderError({
                  code: error.code,
                  retryable: error.retryable,
                  message: error.message,
                  attempts,
                  ...(error.detail === undefined
                    ? {}
                    : { detail: error.detail }),
                }),
              ),
            ),
          ),
        onSuccess: (result: ScrapeResult) =>
          Effect.flatMap(Ref.get(counter), (attempts) =>
            Effect.as(
              Effect.annotateCurrentSpan({
                "shelf.envelope.type": result.envelope.type,
                "shelf.envelope.status_code": result.envelope.statusCode,
                "shelf.attempts": attempts,
              }),
              {
                ...result,
                envelope: { ...result.envelope, attempts },
              } satisfies ScrapeResult,
            ),
          ),
      }),
      Effect.tap(() => Effect.annotateCurrentSpan("shelf.provider", provider)),
      Effect.tapError(() =>
        Effect.annotateCurrentSpan("shelf.provider", provider),
      ),
    )
  })

const make = (options: { readonly launch: Playwright.Launch }) =>
  Effect.gen(function* () {
    const binding = yield* BrowserRendering
    const http = yield* HttpClient.HttpClient
    const deadline = yield* Config.duration("FETCH_ATTEMPT_DEADLINE").pipe(
      Config.withDefault(Duration.seconds(30)),
      Effect.orDie,
    )
    const browserRetry = yield* policy("BROWSER").pipe(Effect.orDie)
    const scrappeyRetry = yield* policy("SCRAPPEY").pipe(Effect.orDie)
    const endpoint = yield* Config.string("SCRAPPEY_ENDPOINT").pipe(
      Config.withDefault(Scrappey.ENDPOINT),
      Effect.orDie,
    )
    const apiKey = yield* Config.redacted("SCRAPPEY_API_KEY").pipe(Effect.orDie)
    const scrappey = Scrappey.clientFor(http, apiKey)

    const fetch = Effect.fn("ScrapeProviders.fetch")(function* (
      mode: ScrapeMode,
      request: ScrapeRequest,
    ) {
      return yield* mode === "basic"
        ? attempted(
            "browser",
            browserRetry,
            Playwright.fetchOnce({
              binding,
              launch: options.launch,
              request,
              deadline,
            }),
          )
        : attempted(
            "scrappey",
            scrappeyRetry,
            Scrappey.fetchOnce({
              client: scrappey,
              endpoint,
              request,
              deadline,
            }),
          )
    })
    return { fetch } satisfies ScrapeProviders["Service"]
  })

/** The live layer, with the Playwright launcher as its one test seam. */
export const layerWith = (options: {
  readonly launch: Playwright.Launch
}): Layer.Layer<
  ScrapeProviders,
  never,
  BrowserRendering | HttpClient.HttpClient
> => Layer.effect(ScrapeProviders, make(options))

export const layer: Layer.Layer<
  ScrapeProviders,
  never,
  BrowserRendering | HttpClient.HttpClient
> = layerWith({ launch: Playwright.launchOnWorkerd })
