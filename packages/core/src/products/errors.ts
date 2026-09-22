export * as ProductsErrors from "./errors"

import * as Data from "effect/Data"
import type { Product } from "@app/schema/product"

export class NotFound extends Data.TaggedError("ProductNotFound")<{
  readonly productId: Product.Id
}> {}
