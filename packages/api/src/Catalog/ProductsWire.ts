import { TimestampWire } from "../TimestampWire.ts"
import { Product } from "@digital-shelf/domain/Catalog/Product"
import { ProductId, BrandId } from "@digital-shelf/domain/Shared/Ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const ProductWire = Schema.Struct({
  ...Product.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})

export type ProductWire = typeof ProductWire.Type

export const toWire = (entity: Product): ProductWire => ({
  ...entity,
})

export const ProductList = Schema.Struct({ items: Schema.Array(ProductWire) })

export const IdParams = Schema.Struct({ id: ProductId })

export const ProductsQuery = Schema.Struct({
  brandId: Schema.optionalKey(BrandId),
})
