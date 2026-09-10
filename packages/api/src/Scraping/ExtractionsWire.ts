import type { Extraction } from "@digital-shelf/domain/Scraping/Extraction"
import type { LatestExtractedData } from "@digital-shelf/domain/Scraping/LatestExtractedData"
import { ScrapeParent } from "@digital-shelf/domain/Scraping/Scrape"
import {
  ExtractionErrorCode,
  ExtractionStatus,
  PromptKind,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import {
  ExtractionId,
  ListingId,
  PageId,
  ProductId,
  ScrapeId,
} from "@digital-shelf/domain/Shared/Ids"
import { Json } from "@digital-shelf/domain/Shared/Refine"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Cursor, Limit } from "../PaginationWire.ts"
import { TimestampWire } from "../TimestampWire.ts"

/**
 * An Extraction goes out whole, prompt snapshot and model included, so an
 * answer can always be attributed to what produced it.
 */
export const ExtractionWire = Schema.Struct({
  id: ExtractionId,
  scrapeId: ScrapeId,
  attempt: Schema.Int,
  status: ExtractionStatus,
  promptKind: PromptKind,
  promptSnapshot: Schema.String,
  model: Schema.String,
  startedAt: Schema.NullOr(TimestampWire),
  finishedAt: Schema.NullOr(TimestampWire),
  extractedJson: Schema.NullOr(Json),
  promptTokens: Schema.NullOr(Schema.Int),
  completionTokens: Schema.NullOr(Schema.Int),
  totalTokens: Schema.NullOr(Schema.Int),
  errorCode: Schema.NullOr(ExtractionErrorCode),
  errorMessage: Schema.NullOr(Schema.String),
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})
export type ExtractionWire = typeof ExtractionWire.Type

export const toWire = (entity: Extraction): ExtractionWire => ({
  id: entity.id,
  scrapeId: entity.scrapeId,
  attempt: entity.attempt,
  status: entity.status,
  promptKind: entity.promptKind,
  promptSnapshot: entity.promptSnapshot,
  model: entity.model,
  startedAt: Option.getOrNull(entity.startedAt),
  finishedAt: Option.getOrNull(entity.finishedAt),
  extractedJson: Option.getOrNull(entity.extractedJson),
  promptTokens: Option.getOrNull(entity.promptTokens),
  completionTokens: Option.getOrNull(entity.completionTokens),
  totalTokens: Option.getOrNull(entity.totalTokens),
  errorCode: Option.getOrNull(entity.errorCode),
  errorMessage: Option.getOrNull(entity.errorMessage),
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
})

export const ExtractionList = Schema.Struct({
  items: Schema.Array(ExtractionWire),
  nextCursor: Schema.NullOr(Cursor),
})

/**
 * Last good data with the identity that produced it. `parent` is the Listing
 * or Page the data belongs to; the provenance names the Scrape it was fetched
 * by and the Extraction, prompt and model it was read with.
 */
export const LatestExtractedDataWire = Schema.Struct({
  parent: ScrapeParent,
  data: Json,
  provenance: Schema.Struct({
    scrapeId: ScrapeId,
    fetchedAt: TimestampWire,
    extractionId: ExtractionId,
    extractedAt: TimestampWire,
    prompt: Schema.String,
    model: Schema.String,
  }),
})
export type LatestExtractedDataWire = typeof LatestExtractedDataWire.Type

/** Timestamps aside, the domain value is already the wire shape. */
export const toLatestWire = (
  entity: LatestExtractedData,
): LatestExtractedDataWire => entity

export const LatestExtractedDataList = Schema.Struct({
  items: Schema.Array(LatestExtractedDataWire),
})

/** No bulk entity: the outcome is the counts (#14). */
export const BulkReExtractReport = Schema.Struct({
  created: Schema.Int,
  skipped: Schema.Int,
})

export const IdParams = Schema.Struct({ id: ExtractionId })
export const ListingIdParams = Schema.Struct({ id: ListingId })
export const PageIdParams = Schema.Struct({ id: PageId })
export const ProductIdParams = Schema.Struct({ id: ProductId })

export const ExtractionsQuery = Schema.Struct({
  scrapeId: Schema.optionalKey(ScrapeId),
  status: Schema.optionalKey(ExtractionStatus),
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(Limit),
})
