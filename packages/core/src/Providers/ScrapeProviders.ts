import type { ScrapeEnvelope } from "@digital-shelf/domain/Scraping/ScrapeEnvelope"
import type { ScrapeMode } from "@digital-shelf/domain/Scraping/Vocabulary"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"

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
