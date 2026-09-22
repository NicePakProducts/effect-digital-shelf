import * as Schema from "effect/Schema"
import {
  ExtractionStatus,
  PromptKind,
  ExtractionErrorCode,
} from "./scraping-vocabulary"
import { ExtractionId, ScrapeId, ProductId, RetailerId } from "./ids"
import { Json, Timestamp, nullable } from "./refine"
import { Scrape } from "./scrape"

export * as Extraction from "./extraction"

/**
 * One attempt to convert a successful Scrape's HTML into clean JSON. Many per
 * Scrape are normal; `attempt` is the 1-based ordinal and never reused.
 */
export const Info = Schema.Struct({
  id: ExtractionId,
  scrapeId: ScrapeId,
  attempt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-2147483648),
    Schema.isLessThanOrEqualTo(2147483647),
  ),
  status: ExtractionStatus,
  promptKind: PromptKind,
  promptSnapshot: Schema.String,
  model: Schema.String,
  startedAt: nullable(Timestamp),
  finishedAt: nullable(Timestamp),
  extractedJson: nullable(Json),
  promptTokens: nullable(Schema.Int),
  completionTokens: nullable(Schema.Int),
  totalTokens: nullable(Schema.Int),
  errorCode: nullable(ExtractionErrorCode),
  errorMessage: nullable(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Info = typeof Info.Type

export const Insert = Schema.Struct({
  id: Schema.optionalKey(ExtractionId),
  scrapeId: ScrapeId,
  attempt: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(-2147483648),
    Schema.isLessThanOrEqualTo(2147483647),
  ),
  status: ExtractionStatus,
  promptKind: PromptKind,
  promptSnapshot: Schema.String,
  model: Schema.String,
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  extractedJson: Schema.optionalKey(nullable(Json)),
  promptTokens: Schema.optionalKey(nullable(Schema.Int)),
  completionTokens: Schema.optionalKey(nullable(Schema.Int)),
  totalTokens: Schema.optionalKey(nullable(Schema.Int)),
  errorCode: Schema.optionalKey(nullable(ExtractionErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(ExtractionId),
  scrapeId: Schema.optionalKey(ScrapeId),
  attempt: Schema.optional(
    Schema.UndefinedOr(
      Schema.Int.check(
        Schema.isGreaterThanOrEqualTo(-2147483648),
        Schema.isLessThanOrEqualTo(2147483647),
      ),
    ),
  ),
  status: Schema.optional(Schema.UndefinedOr(ExtractionStatus)),
  promptKind: Schema.optional(Schema.UndefinedOr(PromptKind)),
  promptSnapshot: Schema.optional(Schema.UndefinedOr(Schema.String)),
  model: Schema.optional(Schema.UndefinedOr(Schema.String)),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  extractedJson: Schema.optionalKey(nullable(Json)),
  promptTokens: Schema.optionalKey(nullable(Schema.Int)),
  completionTokens: Schema.optionalKey(nullable(Schema.Int)),
  totalTokens: Schema.optionalKey(nullable(Schema.Int)),
  errorCode: Schema.optionalKey(nullable(ExtractionErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type UpdateRow = typeof UpdateRow.Type

export const Trigger = Schema.Union([
  Schema.TaggedStruct("Scrape", { scrapeId: ScrapeId }),
  Schema.TaggedStruct("Parent", { parent: Scrape.Parent }),
])

export type Trigger = typeof Trigger.Type

export const Bulk = Schema.Struct({
  retailerId: RetailerId,
  promptKind: PromptKind,
})

export type Bulk = typeof Bulk.Type

export const GetInput = Schema.Struct({ extractionId: ExtractionId })

export type GetInput = typeof GetInput.Type

export const RedispatchInput = Schema.Struct({
  extractionId: ExtractionId,
})

export type RedispatchInput = typeof RedispatchInput.Type

export const DrainPendingInput = Schema.Struct({ limit: Schema.Int })

export type DrainPendingInput = typeof DrainPendingInput.Type

export const ListByScrapeInput = Schema.Struct({
  scrapeId: ScrapeId,
})

export type ListByScrapeInput = typeof ListByScrapeInput.Type

export const LatestDataInput = Schema.Struct({ parent: Scrape.Parent })

export type LatestDataInput = typeof LatestDataInput.Type

export const LatestDataForProductInput = Schema.Struct({
  productId: ProductId,
})

export type LatestDataForProductInput = typeof LatestDataForProductInput.Type

export const Id = ExtractionId

export type Id = typeof Id.Type
