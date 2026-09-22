export * as ProductVariantsErrors from "./errors"

import * as Data from "effect/Data"
import type { Product } from "@app/schema/product"
import type { ProductVariant } from "@app/schema/product-variant"

export class NotFound extends Data.TaggedError("VariantNotFound")<{
  readonly variantId: ProductVariant.Id
}> {}

export class DuplicateName extends Data.TaggedError("DuplicateVariantName")<{
  readonly productId: Product.Id
  readonly name: string
}> {}
