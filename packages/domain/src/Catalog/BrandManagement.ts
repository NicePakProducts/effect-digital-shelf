import * as Schema from "effect/Schema"
import { BrandId } from "../Shared/Ids.ts"
import { Name } from "../Shared/Refine.ts"

/** Commands on Brands as the API accepts them; core turns them into rows. */

export const CreateBrand = Schema.Struct({
  name: Name,
  paused: Schema.optionalKey(Schema.Boolean),
})

export type CreateBrand = typeof CreateBrand.Type

export const UpdateBrand = Schema.Struct({
  name: Schema.optionalKey(Name),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type UpdateBrand = typeof UpdateBrand.Type

/** Inputs to the Brands feature's methods; the api builds them from params and payload. */
export const GetBrandInput = Schema.Struct({ brandId: BrandId })

export type GetBrandInput = typeof GetBrandInput.Type

export const RemoveBrandInput = Schema.Struct({ brandId: BrandId })

export type RemoveBrandInput = typeof RemoveBrandInput.Type

export const BrandImpactInput = Schema.Struct({ brandId: BrandId })

export type BrandImpactInput = typeof BrandImpactInput.Type

export const UpdateBrandInput = Schema.Struct({
  brandId: BrandId,
  command: UpdateBrand,
})

export type UpdateBrandInput = typeof UpdateBrandInput.Type
