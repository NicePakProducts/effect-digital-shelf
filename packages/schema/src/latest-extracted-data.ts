import * as Schema from "effect/Schema"
import { ExtractionId, ScrapeId } from "./ids"
import { Json, Timestamp } from "./refine"
import { Scrape } from "./scrape"

export * as LatestExtractedData from "./latest-extracted-data"

/** Last good data survives newer failed Scrapes and Extractions. */
export const Info = Schema.Struct({
  parent: Scrape.Parent,
  data: Json,
  provenance: Schema.Struct({
    scrapeId: ScrapeId,
    fetchedAt: Timestamp,
    extractionId: ExtractionId,
    extractedAt: Timestamp,
    prompt: Schema.String,
    model: Schema.String,
  }),
})

export type Info = typeof Info.Type
