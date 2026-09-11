import { TimestampWire } from "../TimestampWire.ts"
import { Variant } from "@digital-shelf/domain/Catalog/Variant"
import { VariantId, ProductId } from "@digital-shelf/domain/Shared/Ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const VariantWire = Schema.Struct({
  ...Variant.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})

export type VariantWire = typeof VariantWire.Type

export const toWire = (entity: Variant): VariantWire => ({
  ...entity,
})

export const VariantList = Schema.Struct({ items: Schema.Array(VariantWire) })

export const IdParams = Schema.Struct({ id: VariantId })

export const VariantsQuery = Schema.Struct({
  productId: Schema.optionalKey(ProductId),
})
