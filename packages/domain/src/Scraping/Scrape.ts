import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ListingId, PageId, ScrapeId } from "../Shared/Ids.ts"
import { Json, Timestamp, nullable } from "../Shared/Refine.ts"
import { scrapes } from "../Sql/Scraping.ts"
import { SpanId } from "./Execution.ts"
import { Headers } from "./ScrapeEnvelope.ts"
import { ParentKind, ScrapeErrorCode } from "./Vocabulary.ts"

/** The Listing or Page a Scrape belongs to. Exactly one, always. */
export const ScrapeParent = Schema.Union([
  Schema.TaggedStruct("Listing", { listingId: ListingId }),
  Schema.TaggedStruct("Page", { pageId: PageId }),
])

export type ScrapeParent = typeof ScrapeParent.Type

export const parentKind = (parent: ScrapeParent): ParentKind =>
  Match.value(parent).pipe(
    Match.tags({
      Listing: () => "listing" as const,
      Page: () => "page" as const,
    }),
    Match.exhaustive,
  )

const exactlyOneParent = Schema.makeFilter(
  (row: {
    readonly listingId: Option.Option<unknown>
    readonly pageId: Option.Option<unknown>
  }) =>
    Option.isSome(row.listingId) !== Option.isSome(row.pageId)
      ? undefined
      : "a Scrape has exactly one Parent: a Listing or a Page",
  { identifier: "ExactlyOneParent" },
)

/**
 * One attempt to fetch a Parent's URL and store the result. The row is the
 * source of truth for the outcome; everything the lifecycle has not yet
 * produced is `None`.
 */
export const Scrape = createSelectSchema(scrapes, {
  id: ScrapeId,
  listingId: nullable(ListingId),
  pageId: nullable(PageId),
  rootSpanId: SpanId,
  country: nullable(Schema.String),
  requestHeaders: nullable(Headers),
  startedAt: nullable(Timestamp),
  finishedAt: nullable(Timestamp),
  errorCode: nullable(ScrapeErrorCode),
  errorMessage: nullable(Schema.String),
  htmlR2Key: nullable(Schema.String),
  rawR2Key: nullable(Schema.String),
  finalUrl: nullable(Schema.String),
  statusCode: nullable(Schema.Int),
  responseHeaders: nullable(Headers),
  cookies: nullable(Json),
  innerText: nullable(Schema.String),
  userAgent: nullable(Schema.String),
  ipInfo: nullable(Json),
  type: nullable(Schema.String),
  session: nullable(Schema.String),
  attempts: nullable(Schema.Int),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).check(exactlyOneParent)

export type Scrape = typeof Scrape.Type

/** Total on a decoded Scrape: the check above guarantees one side is set. */
export const parent = (scrape: Scrape): ScrapeParent =>
  Option.match(scrape.listingId, {
    onSome: (listingId) => ScrapeParent.members[0].make({ listingId }),
    onNone: () =>
      ScrapeParent.members[1].make({
        pageId: Option.getOrThrow(scrape.pageId),
      }),
  })

/** The two nullable columns a `ScrapeParent` writes. */
export const parentColumns = (parent: ScrapeParent) =>
  Match.value(parent).pipe(
    Match.tags({
      Listing: ({ listingId }) => ({
        listingId: Option.some(listingId),
        pageId: Option.none(),
      }),
      Page: ({ pageId }) => ({
        listingId: Option.none(),
        pageId: Option.some(pageId),
      }),
    }),
    Match.exhaustive,
  )

export const ScrapeInsert = createInsertSchema(scrapes, {
  id: Schema.optionalKey(ScrapeId),
  listingId: Schema.optionalKey(nullable(ListingId)),
  pageId: Schema.optionalKey(nullable(PageId)),
  rootSpanId: SpanId,
  country: Schema.optionalKey(nullable(Schema.String)),
  requestHeaders: Schema.optionalKey(nullable(Headers)),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  errorCode: Schema.optionalKey(nullable(ScrapeErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  htmlR2Key: Schema.optionalKey(nullable(Schema.String)),
  rawR2Key: Schema.optionalKey(nullable(Schema.String)),
  finalUrl: Schema.optionalKey(nullable(Schema.String)),
  statusCode: Schema.optionalKey(nullable(Schema.Int)),
  responseHeaders: Schema.optionalKey(nullable(Headers)),
  cookies: Schema.optionalKey(nullable(Json)),
  innerText: Schema.optionalKey(nullable(Schema.String)),
  userAgent: Schema.optionalKey(nullable(Schema.String)),
  ipInfo: Schema.optionalKey(nullable(Json)),
  type: Schema.optionalKey(nullable(Schema.String)),
  session: Schema.optionalKey(nullable(Schema.String)),
  attempts: Schema.optionalKey(nullable(Schema.Int)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type ScrapeInsert = typeof ScrapeInsert.Type

export const ScrapeUpdate = createUpdateSchema(scrapes, {
  id: Schema.optionalKey(ScrapeId),
  listingId: Schema.optionalKey(nullable(ListingId)),
  pageId: Schema.optionalKey(nullable(PageId)),
  rootSpanId: Schema.optionalKey(SpanId),
  country: Schema.optionalKey(nullable(Schema.String)),
  requestHeaders: Schema.optionalKey(nullable(Headers)),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  errorCode: Schema.optionalKey(nullable(ScrapeErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  htmlR2Key: Schema.optionalKey(nullable(Schema.String)),
  rawR2Key: Schema.optionalKey(nullable(Schema.String)),
  finalUrl: Schema.optionalKey(nullable(Schema.String)),
  statusCode: Schema.optionalKey(nullable(Schema.Int)),
  responseHeaders: Schema.optionalKey(nullable(Headers)),
  cookies: Schema.optionalKey(nullable(Json)),
  innerText: Schema.optionalKey(nullable(Schema.String)),
  userAgent: Schema.optionalKey(nullable(Schema.String)),
  ipInfo: Schema.optionalKey(nullable(Json)),
  type: Schema.optionalKey(nullable(Schema.String)),
  session: Schema.optionalKey(nullable(Schema.String)),
  attempts: Schema.optionalKey(nullable(Schema.Int)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type ScrapeUpdate = typeof ScrapeUpdate.Type
