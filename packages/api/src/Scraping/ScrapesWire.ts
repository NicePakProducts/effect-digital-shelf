import { SpanId } from "@digital-shelf/domain/Scraping/Execution"
import type { Scrape } from "@digital-shelf/domain/Scraping/Scrape"
import { Headers } from "@digital-shelf/domain/Scraping/ScrapeEnvelope"
import {
  ScrapeErrorCode,
  ScrapeMode,
  ScrapeStatus,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import { ListingId, PageId, ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import { Json } from "@digital-shelf/domain/Shared/Refine"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import { Cursor, Limit } from "../PaginationWire.ts"
import { TimestampWire } from "../TimestampWire.ts"

/**
 * A Scrape as clients see it: the whole row but the R2 keys, which name
 * objects only core may address. `GET /scrapes/:id/content` serves the stored
 * page instead. Options go out as `null`, timestamps as ISO strings.
 */
export const ScrapeWire = Schema.Struct({
  id: ScrapeId,
  listingId: Schema.NullOr(ListingId),
  pageId: Schema.NullOr(PageId),
  mode: ScrapeMode,
  country: Schema.NullOr(Schema.String),
  status: ScrapeStatus,
  rootSpanId: SpanId,
  requestUrl: Schema.String,
  requestHeaders: Schema.NullOr(Headers),
  startedAt: Schema.NullOr(TimestampWire),
  finishedAt: Schema.NullOr(TimestampWire),
  errorCode: Schema.NullOr(ScrapeErrorCode),
  errorMessage: Schema.NullOr(Schema.String),
  finalUrl: Schema.NullOr(Schema.String),
  statusCode: Schema.NullOr(Schema.Int),
  responseHeaders: Schema.NullOr(Headers),
  cookies: Schema.NullOr(Json),
  innerText: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  ipInfo: Schema.NullOr(Json),
  type: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  attempts: Schema.NullOr(Schema.Int),
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})
export type ScrapeWire = typeof ScrapeWire.Type

export const toWire = (entity: Scrape): ScrapeWire => ({
  id: entity.id,
  listingId: Option.getOrNull(entity.listingId),
  pageId: Option.getOrNull(entity.pageId),
  mode: entity.mode,
  country: Option.getOrNull(entity.country),
  status: entity.status,
  rootSpanId: entity.rootSpanId,
  requestUrl: entity.requestUrl,
  requestHeaders: Option.getOrNull(entity.requestHeaders),
  startedAt: Option.getOrNull(entity.startedAt),
  finishedAt: Option.getOrNull(entity.finishedAt),
  errorCode: Option.getOrNull(entity.errorCode),
  errorMessage: Option.getOrNull(entity.errorMessage),
  finalUrl: Option.getOrNull(entity.finalUrl),
  statusCode: Option.getOrNull(entity.statusCode),
  responseHeaders: Option.getOrNull(entity.responseHeaders),
  cookies: Option.getOrNull(entity.cookies),
  innerText: Option.getOrNull(entity.innerText),
  userAgent: Option.getOrNull(entity.userAgent),
  ipInfo: Option.getOrNull(entity.ipInfo),
  type: Option.getOrNull(entity.type),
  session: Option.getOrNull(entity.session),
  attempts: Option.getOrNull(entity.attempts),
  createdAt: entity.createdAt,
  updatedAt: entity.updatedAt,
})

export const ScrapeList = Schema.Struct({
  items: Schema.Array(ScrapeWire),
  nextCursor: Schema.NullOr(Cursor),
})

/**
 * The stored page, served as plain text rather than wrapped in JSON. It is a
 * third party's HTML, so it is never labelled `text/html`: a browser must not
 * render it, or run its scripts, on the API's origin with the session cookie.
 */
export const ScrapeContent = Schema.String.pipe(
  HttpApiSchema.asText({ contentType: "text/plain; charset=utf-8" }),
)

/** No bulk entity: the outcome is the counts (#14). */
export const BulkScrapeReport = Schema.Struct({
  created: Schema.Int,
  skippedInFlight: Schema.Int,
  skippedPaused: Schema.Int,
})

export const IdParams = Schema.Struct({ id: ScrapeId })

export const ScrapesQuery = Schema.Struct({
  listingId: Schema.optionalKey(ListingId),
  pageId: Schema.optionalKey(PageId),
  status: Schema.optionalKey(ScrapeStatus),
  cursor: Schema.optionalKey(Cursor),
  limit: Schema.optionalKey(Limit),
})
