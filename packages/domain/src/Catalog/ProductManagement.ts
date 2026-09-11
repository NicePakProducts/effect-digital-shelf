import * as Schema from "effect/Schema"
import { BrandId, ProductId } from "../Shared/Ids.ts"
import { Name } from "../Shared/Refine.ts"

/** A Product is created under a Brand and never moves. */

export const CreateProduct = Schema.Struct({
  brandId: BrandId,
  name: Name,
  paused: Schema.optionalKey(Schema.Boolean),
})

export type CreateProduct = typeof CreateProduct.Type

export const UpdateProduct = Schema.Struct({
  name: Schema.optionalKey(Name),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type UpdateProduct = typeof UpdateProduct.Type

export const GetProductInput = Schema.Struct({ productId: ProductId })

export type GetProductInput = typeof GetProductInput.Type

export const RemoveProductInput = Schema.Struct({ productId: ProductId })

export type RemoveProductInput = typeof RemoveProductInput.Type

export const ProductImpactInput = Schema.Struct({ productId: ProductId })

export type ProductImpactInput = typeof ProductImpactInput.Type

export const UpdateProductInput = Schema.Struct({
  productId: ProductId,
  command: UpdateProduct,
})

export type UpdateProductInput = typeof UpdateProductInput.Type
