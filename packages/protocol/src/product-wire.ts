import { Product } from "@app/schema/product"
import { TimestampWire } from "./timestamp"
import { ProductId, BrandId } from "@app/schema/ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const ProductWire = Schema.Struct({
  ...Product.Info.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})

export type ProductWire = typeof ProductWire.Type

export const toWire = (entity: Product.Info): ProductWire => ({
  ...entity,
})

export const ProductList = Schema.Struct({ items: Schema.Array(ProductWire) })

export const IdParams = Schema.Struct({ id: ProductId })

export const ProductsQuery = Schema.Struct({
  brandId: Schema.optionalKey(BrandId),
})
