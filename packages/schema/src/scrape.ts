import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  ScrapeMode,
  ScrapeStatus,
  ParentKind,
  ScrapeErrorCode,
} from "./scraping-vocabulary"
import {
  ListingId,
  PageId,
  ScrapeId,
  BrandId,
  ProductId,
  RetailerId,
} from "./ids"
import { Json, Timestamp, nullable } from "./refine"
import { Execution } from "./execution"
import { ScrapeEnvelope } from "./scrape-envelope"

export * as Scrape from "./scrape"

/** The Listing or Page a Scrape belongs to. Exactly one, always. */
export const Parent = Schema.Union([
  Schema.TaggedStruct("Listing", { listingId: ListingId }),
  Schema.TaggedStruct("Page", { pageId: PageId }),
])

export type Parent = typeof Parent.Type

export const parentKind = (parent: Parent): ParentKind =>
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
export const Info = Schema.Struct({
  id: ScrapeId,
  listingId: nullable(ListingId),
  pageId: nullable(PageId),
  mode: ScrapeMode,
  country: nullable(Schema.String),
  status: ScrapeStatus,
  rootSpanId: Execution.SpanId,
  requestUrl: Schema.String,
  requestHeaders: nullable(ScrapeEnvelope.Headers),
  startedAt: nullable(Timestamp),
  finishedAt: nullable(Timestamp),
  errorCode: nullable(ScrapeErrorCode),
  errorMessage: nullable(Schema.String),
  htmlR2Key: nullable(Schema.String),
  rawR2Key: nullable(Schema.String),
  finalUrl: nullable(Schema.String),
  statusCode: nullable(Schema.Int),
  responseHeaders: nullable(ScrapeEnvelope.Headers),
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

export type Info = typeof Info.Type

/** Total on a decoded Scrape: the check above guarantees one side is set. */
export const parent = (scrape: Info): Parent =>
  Option.match(scrape.listingId, {
    onSome: (listingId) => Parent.members[0].make({ listingId }),
    onNone: () =>
      Parent.members[1].make({
        pageId: Option.getOrThrow(scrape.pageId),
      }),
  })

/** The two nullable columns a `ScrapeParent` writes. */
export const parentColumns = (parent: Parent) =>
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

export const Insert = Schema.Struct({
  id: Schema.optionalKey(ScrapeId),
  listingId: Schema.optionalKey(nullable(ListingId)),
  pageId: Schema.optionalKey(nullable(PageId)),
  mode: ScrapeMode,
  country: Schema.optionalKey(nullable(Schema.String)),
  status: ScrapeStatus,
  rootSpanId: Execution.SpanId,
  requestUrl: Schema.String,
  requestHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  errorCode: Schema.optionalKey(nullable(ScrapeErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  htmlR2Key: Schema.optionalKey(nullable(Schema.String)),
  rawR2Key: Schema.optionalKey(nullable(Schema.String)),
  finalUrl: Schema.optionalKey(nullable(Schema.String)),
  statusCode: Schema.optionalKey(nullable(Schema.Int)),
  responseHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
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

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(ScrapeId),
  listingId: Schema.optionalKey(nullable(ListingId)),
  pageId: Schema.optionalKey(nullable(PageId)),
  mode: Schema.optional(Schema.UndefinedOr(ScrapeMode)),
  country: Schema.optionalKey(nullable(Schema.String)),
  status: Schema.optional(Schema.UndefinedOr(ScrapeStatus)),
  rootSpanId: Schema.optionalKey(Execution.SpanId),
  requestUrl: Schema.optional(Schema.UndefinedOr(Schema.String)),
  requestHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  errorCode: Schema.optionalKey(nullable(ScrapeErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  htmlR2Key: Schema.optionalKey(nullable(Schema.String)),
  rawR2Key: Schema.optionalKey(nullable(Schema.String)),
  finalUrl: Schema.optionalKey(nullable(Schema.String)),
  statusCode: Schema.optionalKey(nullable(Schema.Int)),
  responseHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
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

export type UpdateRow = typeof UpdateRow.Type

export const Trigger = Schema.Struct({
  parent: Parent,
  mode: Schema.optionalKey(ScrapeMode),
  country: Schema.optionalKey(Schema.NonEmptyString),
})

export type Trigger = typeof Trigger.Type

export const Bulk = Schema.Union([
  Schema.TaggedStruct("Brand", { brandId: BrandId }),
  Schema.TaggedStruct("Product", { productId: ProductId }),
  Schema.TaggedStruct("Retailer", { retailerId: RetailerId }),
])

export type Bulk = typeof Bulk.Type

export const GetInput = Schema.Struct({ scrapeId: ScrapeId })

export type GetInput = typeof GetInput.Type

export const ContentInput = Schema.Struct({ scrapeId: ScrapeId })

export type ContentInput = typeof ContentInput.Type

export const DrainPendingInput = Schema.Struct({ limit: Schema.Int })

export type DrainPendingInput = typeof DrainPendingInput.Type

export const DispatchDueInput = Schema.Struct({
  now: Schema.DateTimeUtc,
  limit: Schema.Int,
})

export type DispatchDueInput = typeof DispatchDueInput.Type

export const Id = ScrapeId

export type Id = typeof Id.Type
