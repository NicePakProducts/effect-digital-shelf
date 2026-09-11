import * as Schema from "effect/Schema"
import { ProductId } from "../Shared/Ids.ts"
import { Name } from "../Shared/Refine.ts"

export const CreateVariant = Schema.Struct({
  productId: ProductId,
  name: Name,
})

export type CreateVariant = typeof CreateVariant.Type

export const UpdateVariant = Schema.Struct({
  name: Name,
})

export type UpdateVariant = typeof UpdateVariant.Type
