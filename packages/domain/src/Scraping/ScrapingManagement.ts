import * as Schema from "effect/Schema"
import { BrandId, ProductId, RetailerId, ScrapeId } from "../Shared/Ids.ts"
import { ScrapeParent } from "./Scrape.ts"
import { PromptKind, ScrapeMode } from "./Vocabulary.ts"

/**
 * Triggers. Manual triggers bypass pause and may override the Retailer's
 * scrape defaults per call; bulk triggers respect effective pause and never
 * override. There is no bulk-job entity: the outcome is the rows created.
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
