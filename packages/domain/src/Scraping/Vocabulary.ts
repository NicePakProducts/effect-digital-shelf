import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * The literal sets of the scraping vocabulary (CONTEXT.md). Each tuple is the
 * single source: Sql/ builds the Postgres enum or CHECK from it and the schema
 * beside it is what every other package decodes with. Spelling is lower-case
 * snake in storage and on the wire; display forms belong to the UI.
 */

export const ScrapeModes = ["basic", "advance"] as const
export const ScrapeMode = Schema.Literals(ScrapeModes)
export type ScrapeMode = typeof ScrapeMode.Type

/** Shared by both lifecycles; the two statuses stay distinct names. */
export const LifecycleStatuses = [
  "pending",
  "running",
  "success",
  "failed",
] as const

export const ScrapeStatus = Schema.Literals(LifecycleStatuses)
export type ScrapeStatus = typeof ScrapeStatus.Type

export const ExtractionStatus = Schema.Literals(LifecycleStatuses)
export type ExtractionStatus = typeof ExtractionStatus.Type

export const ParentKinds = ["listing", "page"] as const

export const ParentKind = Schema.Literals(ParentKinds)
export type ParentKind = typeof ParentKind.Type

/** Equals the Parent kind of the Extraction's Scrape. */
export const PromptKind = Schema.Literals(ParentKinds)
export type PromptKind = typeof PromptKind.Type

/** Evolving sets: stored as text with a CHECK, not a Postgres enum. */
export const ScrapeErrorCodes = [
  "timeout",
  "navigation_failed",
  "blocked",
  "provider_error",
  "invalid_url",
  "parent_deleted",
  "unknown",
] as const
export const ScrapeErrorCode = Schema.Literals(ScrapeErrorCodes)
export type ScrapeErrorCode = typeof ScrapeErrorCode.Type

export const ExtractionErrorCodes = [
  "provider_error",
  "json_mode_unmet",
  "invalid_json",
  "llm_timeout",
  "context_overflow",
  "unknown",
] as const
export const ExtractionErrorCode = Schema.Literals(ExtractionErrorCodes)
export type ExtractionErrorCode = typeof ExtractionErrorCode.Type

export const CombinedStatuses = [
  "failed",
  "pending",
  "running",
  "success",
  "none",
] as const
export const CombinedStatus = Schema.Literals(CombinedStatuses)
export type CombinedStatus = typeof CombinedStatus.Type
/** The glossary's Combined status: dominant-failure reading, failed > pending > running > success > none. */
export const combinedStatus = (
  scrape: Option.Option<ScrapeStatus>,
  extraction: Option.Option<ExtractionStatus>,
): CombinedStatus => {
  if (Option.isNone(scrape)) return "none"
  if (Option.isNone(extraction)) return scrape.value
  return CombinedStatuses.indexOf(scrape.value) <=
    CombinedStatuses.indexOf(extraction.value)
    ? scrape.value
    : extraction.value
}
