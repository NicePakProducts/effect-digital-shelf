export * as ListingsErrors from "./errors"

import * as Data from "effect/Data"
import type { ListingId, VariantId, ProductId } from "@app/schema/ids"

export class NotFound extends Data.TaggedError("ListingNotFound")<{
  readonly listingId: ListingId
}> {}

export class VariantNotInProduct extends Data.TaggedError(
  "VariantNotInProduct",
)<{
  readonly variantId: VariantId
  readonly productId: ProductId
}> {}
