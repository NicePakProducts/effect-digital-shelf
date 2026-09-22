import { ProductVariant } from "@app/schema/product-variant"
import { TimestampWire } from "./timestamp"
import { VariantId, ProductId } from "@app/schema/ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const VariantWire = Schema.Struct({
  ...ProductVariant.Info.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})

export type VariantWire = typeof VariantWire.Type

export const toWire = (entity: ProductVariant.Info): VariantWire => ({
  ...entity,
})

export const VariantList = Schema.Struct({ items: Schema.Array(VariantWire) })

export const IdParams = Schema.Struct({ id: VariantId })

export const VariantsQuery = Schema.Struct({
  productId: Schema.optionalKey(ProductId),
})
