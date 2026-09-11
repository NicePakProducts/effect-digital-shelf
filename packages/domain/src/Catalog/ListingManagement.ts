import * as Schema from "effect/Schema"
import { ProductId, RetailerId, VariantId, ListingId } from "../Shared/Ids.ts"
import { Url } from "../Shared/Refine.ts"
import { Cadence } from "./Cadence.ts"

/**
 * Variant coverage travels with the Listing command as a full set: an update
 * that names `variantIds` replaces the coverage, one that omits it leaves the
 * coverage alone.
 */
export const CreateListing = Schema.Struct({
  productId: ProductId,
  retailerId: RetailerId,
  url: Url,
  cadence: Schema.optionalKey(Cadence),
  variantIds: Schema.optionalKey(Schema.Array(VariantId)),
})

export type CreateListing = typeof CreateListing.Type

export const UpdateListing = Schema.Struct({
  url: Schema.optionalKey(Url),
  cadence: Schema.optionalKey(Cadence),
  variantIds: Schema.optionalKey(Schema.Array(VariantId)),
})

export type UpdateListing = typeof UpdateListing.Type

export const GetListingInput = Schema.Struct({ listingId: ListingId })

export type GetListingInput = typeof GetListingInput.Type

export const RemoveListingInput = Schema.Struct({ listingId: ListingId })

export type RemoveListingInput = typeof RemoveListingInput.Type

export const ListingImpactInput = Schema.Struct({ listingId: ListingId })

export type ListingImpactInput = typeof ListingImpactInput.Type

export const UpdateListingInput = Schema.Struct({
  listingId: ListingId,
  command: UpdateListing,
})

export type UpdateListingInput = typeof UpdateListingInput.Type
