import * as Schema from "effect/Schema"
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
