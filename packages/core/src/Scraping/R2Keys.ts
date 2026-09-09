import type { ScrapeId } from "@digital-shelf/domain/Shared/Ids"

/**
 * Object keys are derived from the Scrape id, so a sweep can remove a
 * Scrape's objects from the id alone and the bucket lifecycle rule can
 * target the two prefixes (ADR 0001).
 */
export const htmlKey = (scrapeId: ScrapeId): string => `html/${scrapeId}.html`

export const rawKey = (scrapeId: ScrapeId): string => `raw/${scrapeId}.json`

export const keysOf = (scrapeId: ScrapeId): ReadonlyArray<string> => [
  htmlKey(scrapeId),
  rawKey(scrapeId),
]
