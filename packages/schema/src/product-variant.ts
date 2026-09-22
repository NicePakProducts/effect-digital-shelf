import * as Schema from "effect/Schema"
import { ProductId, VariantId } from "./ids"
import { Timestamp, Name } from "./refine"

export * as ProductVariant from "./product-variant"

/**
 * A size, shade or pack count of one Product. The name is unique within the
 * Product ignoring case; the database enforces it, core trims it first.
 */
export const Info = Schema.Struct({
  id: VariantId,
  productId: ProductId,
  name: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Info = typeof Info.Type

export const Insert = Schema.Struct({
  id: Schema.optionalKey(VariantId),
  productId: ProductId,
  name: Schema.String,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(VariantId),
  productId: Schema.optionalKey(ProductId),
  name: Schema.optional(Schema.UndefinedOr(Schema.String)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type UpdateRow = typeof UpdateRow.Type

export const Create = Schema.Struct({
  productId: ProductId,
  name: Name,
})

export type Create = typeof Create.Type

export const Update = Schema.Struct({
  name: Name,
})

export type Update = typeof Update.Type

export const GetInput = Schema.Struct({ variantId: VariantId })

export type GetInput = typeof GetInput.Type

export const RemoveInput = Schema.Struct({ variantId: VariantId })

export type RemoveInput = typeof RemoveInput.Type

export const UpdateInput = Schema.Struct({
  variantId: VariantId,
  command: Update,
})

export type UpdateInput = typeof UpdateInput.Type

export const NotInProductInput = Schema.Struct({
  productId: ProductId,
  variantIds: Schema.Array(VariantId),
})

export type NotInProductInput = typeof NotInProductInput.Type

export const Id = VariantId

export type Id = typeof Id.Type
