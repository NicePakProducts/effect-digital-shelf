import * as Schema from "effect/Schema"
import { Cadence } from "./cadence"
import { CombinedStatus } from "./scraping-vocabulary"
import { ListingId, ProductId, RetailerId, VariantId } from "./ids"
import { Timestamp, Url, nullable } from "./refine"

export * as Listing from "./listing"

/**
 * A Product's page on a Retailer. Variant coverage is the `listing_variants`
 * edge, chosen by the user and never derived from scrape data.
 */
export const Info = Schema.Struct({
  id: ListingId,
  productId: ProductId,
  retailerId: RetailerId,
  url: Url,
  cadence: Cadence,
  lastScrapedAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Info = typeof Info.Type

export const Insert = Schema.Struct({
  id: Schema.optionalKey(ListingId),
  productId: ProductId,
  retailerId: RetailerId,
  url: Url,
  cadence: Cadence,
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(ListingId),
  productId: Schema.optionalKey(ProductId),
  retailerId: Schema.optionalKey(RetailerId),
  url: Schema.optionalKey(Url),
  cadence: Schema.optional(Schema.UndefinedOr(Cadence)),
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type UpdateRow = typeof UpdateRow.Type

/** One row of Variant coverage. */
export const Variant = Schema.Struct({
  listingId: ListingId,
  variantId: VariantId,
})

export type Variant = typeof Variant.Type

/** A Listing as the api reads it, with its derived pause and status readings. */
export const WithStatus = Schema.Struct({
  ...Info.fields,
  variantIds: Schema.Array(VariantId),
  effectivePaused: Schema.Boolean,
  combinedStatus: CombinedStatus,
})

export type WithStatus = typeof WithStatus.Type

/**
 * Variant coverage travels with the Listing command as a full set: an update
 * that names `variantIds` replaces the coverage, one that omits it leaves the
 * coverage alone.
 */
export const Create = Schema.Struct({
  productId: ProductId,
  retailerId: RetailerId,
  url: Url,
  cadence: Schema.optionalKey(Cadence),
  variantIds: Schema.optionalKey(Schema.Array(VariantId)),
})

export type Create = typeof Create.Type

export const Update = Schema.Struct({
  url: Schema.optionalKey(Url),
  cadence: Schema.optionalKey(Cadence),
  variantIds: Schema.optionalKey(Schema.Array(VariantId)),
})

export type Update = typeof Update.Type

export const GetInput = Schema.Struct({ listingId: ListingId })

export type GetInput = typeof GetInput.Type

export const RemoveInput = Schema.Struct({ listingId: ListingId })

export type RemoveInput = typeof RemoveInput.Type

export const ImpactInput = Schema.Struct({ listingId: ListingId })

export type ImpactInput = typeof ImpactInput.Type

export const UpdateInput = Schema.Struct({
  listingId: ListingId,
  command: Update,
})

export type UpdateInput = typeof UpdateInput.Type

export const MarkScrapedInput = Schema.Struct({
  listingId: ListingId,
  at: Timestamp,
})

export type MarkScrapedInput = typeof MarkScrapedInput.Type

export const Id = ListingId

export type Id = typeof Id.Type
