import * as Schema from "effect/Schema"
import { BrandId } from "../Shared/Ids.ts"
import { Name } from "../Shared/Refine.ts"

/** Commands on Brands as the API accepts them; core turns them into rows. */

export const CreateBrand = Schema.Struct({
  name: Name,
  paused: Schema.optionalKey(Schema.Boolean),
})

export type CreateBrand = typeof CreateBrand.Type

export const UpdateBrandCommand = Schema.Struct({
  name: Schema.optionalKey(Name),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type UpdateBrandCommand = typeof UpdateBrandCommand.Type

/** Inputs to the Brands feature's methods; the api builds them from params and payload. */
export const GetBrand = Schema.Struct({ brandId: BrandId })

export type GetBrand = typeof GetBrand.Type

export const RemoveBrand = GetBrand

export type RemoveBrand = typeof RemoveBrand.Type

export const BrandImpact = GetBrand

export type BrandImpact = typeof BrandImpact.Type

export const UpdateBrand = Schema.Struct({
  brandId: BrandId,
  command: UpdateBrandCommand,
})

export type UpdateBrand = typeof UpdateBrand.Type
