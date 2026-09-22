import * as Schema from "effect/Schema"
import { BrandId } from "./ids"
import { Timestamp, Name } from "./refine"

export * as Brand from "./brand"

/** A top-level commercial identity. Sub-brands are separate Brands. */
export const Info = Schema.Struct({
  id: BrandId,
  name: Schema.String,
  paused: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Info = typeof Info.Type

export const Insert = Schema.Struct({
  id: Schema.optionalKey(BrandId),
  name: Schema.String,
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(BrandId),
  name: Schema.optional(Schema.UndefinedOr(Schema.String)),
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type UpdateRow = typeof UpdateRow.Type

/** Commands on Brands as the API accepts them; core turns them into rows. */

export const Create = Schema.Struct({
  name: Name,
  paused: Schema.optionalKey(Schema.Boolean),
})

export type Create = typeof Create.Type

export const Update = Schema.Struct({
  name: Schema.optionalKey(Name),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type Update = typeof Update.Type

/** Inputs to the Brands feature's methods; the api builds them from params and payload. */
export const GetInput = Schema.Struct({ brandId: BrandId })

export type GetInput = typeof GetInput.Type

export const RemoveInput = Schema.Struct({ brandId: BrandId })

export type RemoveInput = typeof RemoveInput.Type

export const ImpactInput = Schema.Struct({ brandId: BrandId })

export type ImpactInput = typeof ImpactInput.Type

export const UpdateInput = Schema.Struct({
  brandId: BrandId,
  command: Update,
})

export type UpdateInput = typeof UpdateInput.Type

export const Id = BrandId

export type Id = typeof Id.Type
