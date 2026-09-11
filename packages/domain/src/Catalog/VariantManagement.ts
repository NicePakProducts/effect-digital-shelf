import * as Schema from "effect/Schema"
import { ProductId, VariantId } from "../Shared/Ids.ts"
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

export const GetVariantInput = Schema.Struct({ variantId: VariantId })

export type GetVariantInput = typeof GetVariantInput.Type

export const RemoveVariantInput = Schema.Struct({ variantId: VariantId })

export type RemoveVariantInput = typeof RemoveVariantInput.Type

export const UpdateVariantInput = Schema.Struct({
  variantId: VariantId,
  command: UpdateVariant,
})

export type UpdateVariantInput = typeof UpdateVariantInput.Type
