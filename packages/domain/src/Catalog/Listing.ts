import { CombinedStatus } from "../Scraping/Vocabulary.ts"
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Schema from "effect/Schema"
import { ListingId, ProductId, RetailerId, VariantId } from "../Shared/Ids.ts"
import { Timestamp, nullable } from "../Shared/Refine.ts"
import { listingVariants, listings } from "../Sql/Catalog.ts"

/**
 * A Product's page on a Retailer. Variant coverage is the `listing_variants`
 * edge, chosen by the user and never derived from scrape data.
 */
export const Listing = createSelectSchema(listings, {
  id: ListingId,
  productId: ProductId,
  retailerId: RetailerId,
  lastScrapedAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Listing = typeof Listing.Type

export const ListingInsert = createInsertSchema(listings, {
  id: Schema.optionalKey(ListingId),
  productId: ProductId,
  retailerId: RetailerId,
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type ListingInsert = typeof ListingInsert.Type

export const ListingUpdate = createUpdateSchema(listings, {
  id: Schema.optionalKey(ListingId),
  productId: Schema.optionalKey(ProductId),
  retailerId: Schema.optionalKey(RetailerId),
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type ListingUpdate = typeof ListingUpdate.Type

/** One row of Variant coverage. */
export const ListingVariant = createSelectSchema(listingVariants, {
  listingId: ListingId,
  variantId: VariantId,
})
export type ListingVariant = typeof ListingVariant.Type

/** A Listing as the api reads it, with its derived pause and status readings. */
export const ListingWithStatus = Schema.Struct({
  ...Listing.fields,
  variantIds: Schema.Array(VariantId),
  effectivePaused: Schema.Boolean,
  combinedStatus: CombinedStatus,
})
export type ListingWithStatus = typeof ListingWithStatus.Type
