import * as Schema from "effect/Schema"
import { BrandId, ProductId } from "./ids"
import { Timestamp, Name } from "./refine"

export * as Product from "./product"

/** A sellable item under exactly one Brand. */
export const Info = Schema.Struct({
  id: ProductId,
  brandId: BrandId,
  name: Schema.String,
  paused: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Info = typeof Info.Type

export const Insert = Schema.Struct({
  id: Schema.optionalKey(ProductId),
  brandId: BrandId,
  name: Schema.String,
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(ProductId),
  brandId: Schema.optionalKey(BrandId),
  name: Schema.optional(Schema.UndefinedOr(Schema.String)),
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type UpdateRow = typeof UpdateRow.Type

/** A Product is created under a Brand and never moves. */

export const Create = Schema.Struct({
  brandId: BrandId,
  name: Name,
  paused: Schema.optionalKey(Schema.Boolean),
})

export type Create = typeof Create.Type

export const Update = Schema.Struct({
  name: Schema.optionalKey(Name),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type Update = typeof Update.Type

export const GetInput = Schema.Struct({ productId: ProductId })

export type GetInput = typeof GetInput.Type

export const RemoveInput = Schema.Struct({ productId: ProductId })

export type RemoveInput = typeof RemoveInput.Type

export const ImpactInput = Schema.Struct({ productId: ProductId })

export type ImpactInput = typeof ImpactInput.Type

export const UpdateInput = Schema.Struct({
  productId: ProductId,
  command: Update,
})

export type UpdateInput = typeof UpdateInput.Type

export const Id = ProductId

export type Id = typeof Id.Type
