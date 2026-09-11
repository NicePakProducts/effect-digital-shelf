import * as Schema from "effect/Schema"
import { BrandId } from "../Shared/Ids.ts"
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
