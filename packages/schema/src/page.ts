import * as Schema from "effect/Schema"
import { Cadence } from "./cadence"
import { CombinedStatus } from "./scraping-vocabulary"
import { BrandId, PageId, RetailerId } from "./ids"
import { Timestamp, Url, nullable } from "./refine"

export * as Page from "./page"

/** A Brand's storefront or brand page on a Retailer, unique per pair. */
export const Info = Schema.Struct({
  id: PageId,
  brandId: BrandId,
  retailerId: RetailerId,
  url: Url,
  cadence: Cadence,
  paused: Schema.Boolean,
  lastScrapedAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Info = typeof Info.Type

export const Insert = Schema.Struct({
  id: Schema.optionalKey(PageId),
  brandId: BrandId,
  retailerId: RetailerId,
  url: Url,
  cadence: Cadence,
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(PageId),
  brandId: Schema.optionalKey(BrandId),
  retailerId: Schema.optionalKey(RetailerId),
  url: Schema.optionalKey(Url),
  cadence: Schema.optional(Schema.UndefinedOr(Cadence)),
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type UpdateRow = typeof UpdateRow.Type

/** A Page as the api reads it, with its derived pause and status readings. */
export const WithStatus = Schema.Struct({
  ...Info.fields,

  effectivePaused: Schema.Boolean,
  combinedStatus: CombinedStatus,
})

export type WithStatus = typeof WithStatus.Type

export const Create = Schema.Struct({
  brandId: BrandId,
  retailerId: RetailerId,
  url: Url,
  cadence: Schema.optionalKey(Cadence),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type Create = typeof Create.Type

export const Update = Schema.Struct({
  url: Schema.optionalKey(Url),
  cadence: Schema.optionalKey(Cadence),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type Update = typeof Update.Type

export const GetInput = Schema.Struct({ pageId: PageId })

export type GetInput = typeof GetInput.Type

export const RemoveInput = Schema.Struct({ pageId: PageId })

export type RemoveInput = typeof RemoveInput.Type

export const ImpactInput = Schema.Struct({ pageId: PageId })

export type ImpactInput = typeof ImpactInput.Type

export const UpdateInput = Schema.Struct({
  pageId: PageId,
  command: Update,
})

export type UpdateInput = typeof UpdateInput.Type

export const MarkScrapedInput = Schema.Struct({
  pageId: PageId,
  at: Timestamp,
})

export type MarkScrapedInput = typeof MarkScrapedInput.Type

export const Id = PageId

export type Id = typeof Id.Type
