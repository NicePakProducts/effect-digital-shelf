import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Schema from "effect/Schema"
import { BrandId, ProductId } from "../Shared/Ids.ts"
import { Timestamp } from "../Shared/Refine.ts"
import { products } from "../Sql/Catalog.ts"

/** A sellable item under exactly one Brand. */
export const Product = createSelectSchema(products, {
  id: ProductId,
  brandId: BrandId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Product = typeof Product.Type

export const ProductInsert = createInsertSchema(products, {
  id: Schema.optionalKey(ProductId),
  brandId: BrandId,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type ProductInsert = typeof ProductInsert.Type

export const ProductUpdate = createUpdateSchema(products, {
  id: Schema.optionalKey(ProductId),
  brandId: Schema.optionalKey(BrandId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type ProductUpdate = typeof ProductUpdate.Type
