import * as Schema from "effect/Schema"
import { ExtractionId, ScrapeId } from "../Shared/Ids.ts"
import { Json, Timestamp } from "../Shared/Refine.ts"
import { ScrapeParent } from "./Scrape.ts"

/** Last good data survives newer failed Scrapes and Extractions. */
export const LatestExtractedData = Schema.Struct({
  parent: ScrapeParent,
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

export type LatestExtractedData = typeof LatestExtractedData.Type
