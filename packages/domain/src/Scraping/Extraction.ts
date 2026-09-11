import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Schema from "effect/Schema"
import { ExtractionId, ScrapeId } from "../Shared/Ids.ts"
import { Json, Timestamp, nullable } from "../Shared/Refine.ts"
import { extractions } from "../Sql/Scraping.ts"
import { ExtractionErrorCode } from "./Vocabulary.ts"

/**
 * One attempt to convert a successful Scrape's HTML into clean JSON. Many per
 * Scrape are normal; `attempt` is the 1-based ordinal and never reused.
 */
export const Extraction = createSelectSchema(extractions, {
  id: ExtractionId,
  scrapeId: ScrapeId,
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

export type Extraction = typeof Extraction.Type

export const ExtractionInsert = createInsertSchema(extractions, {
  id: Schema.optionalKey(ExtractionId),
  scrapeId: ScrapeId,
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

export type ExtractionInsert = typeof ExtractionInsert.Type

export const ExtractionUpdate = createUpdateSchema(extractions, {
  id: Schema.optionalKey(ExtractionId),
  scrapeId: Schema.optionalKey(ScrapeId),
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

export type ExtractionUpdate = typeof ExtractionUpdate.Type
