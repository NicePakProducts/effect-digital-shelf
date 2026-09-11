import * as Schema from "effect/Schema"
import {
  BrandId,
  ExtractionId,
  ProductId,
  RetailerId,
  ScrapeId,
} from "../Shared/Ids.ts"
import { ScrapeParent } from "./Scrape.ts"
import { PromptKind, ScrapeMode } from "./Vocabulary.ts"

/**
 * Triggers. Manual triggers bypass pause and may override the Retailer's
 * scrape defaults per call; bulk triggers respect effective pause and never
 * override. There is no bulk-job entity: the outcome is the rows created and
 * the Parents skipped, in flight or paused.
 */

export const TriggerScrape = Schema.Struct({
  parent: ScrapeParent,
  mode: Schema.optionalKey(ScrapeMode),
  country: Schema.optionalKey(Schema.NonEmptyString),
})

export type TriggerScrape = typeof TriggerScrape.Type

/** Re-extract one Scrape with the Retailer's current prompt. */
export const TriggerExtraction = Schema.Union([
  Schema.TaggedStruct("Scrape", { scrapeId: ScrapeId }),
  Schema.TaggedStruct("Parent", { parent: ScrapeParent }),
])

export type TriggerExtraction = typeof TriggerExtraction.Type

/** "Scrape all" on a container. */
export const BulkScrape = Schema.Union([
  Schema.TaggedStruct("Brand", { brandId: BrandId }),
  Schema.TaggedStruct("Product", { productId: ProductId }),
  Schema.TaggedStruct("Retailer", { retailerId: RetailerId }),
])

export type BulkScrape = typeof BulkScrape.Type

/** "Re-extract all" on a Retailer for one Parent kind. */
export const BulkReExtract = Schema.Struct({
  retailerId: RetailerId,
  promptKind: PromptKind,
})

export type BulkReExtract = typeof BulkReExtract.Type

export const GetScrapeInput = Schema.Struct({ scrapeId: ScrapeId })

export type GetScrapeInput = typeof GetScrapeInput.Type

export const ScrapeContentInput = Schema.Struct({ scrapeId: ScrapeId })

export type ScrapeContentInput = typeof ScrapeContentInput.Type

export const DrainPendingScrapesInput = Schema.Struct({ limit: Schema.Int })

export type DrainPendingScrapesInput = typeof DrainPendingScrapesInput.Type

export const DispatchDueScrapesInput = Schema.Struct({
  now: Schema.DateTimeUtc,
  limit: Schema.Int,
})

export type DispatchDueScrapesInput = typeof DispatchDueScrapesInput.Type

export const GetExtractionInput = Schema.Struct({ extractionId: ExtractionId })

export type GetExtractionInput = typeof GetExtractionInput.Type

export const RedispatchExtractionInput = Schema.Struct({
  extractionId: ExtractionId,
})

export type RedispatchExtractionInput = typeof RedispatchExtractionInput.Type

export const DrainPendingExtractionsInput = Schema.Struct({ limit: Schema.Int })

export type DrainPendingExtractionsInput =
  typeof DrainPendingExtractionsInput.Type

export const ListExtractionsByScrapeInput = Schema.Struct({
  scrapeId: ScrapeId,
})

export type ListExtractionsByScrapeInput =
  typeof ListExtractionsByScrapeInput.Type

export const LatestExtractedDataInput = Schema.Struct({ parent: ScrapeParent })

export type LatestExtractedDataInput = typeof LatestExtractedDataInput.Type

export const LatestExtractedDataForProductInput = Schema.Struct({
  productId: ProductId,
})

export type LatestExtractedDataForProductInput =
  typeof LatestExtractedDataForProductInput.Type
