import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Schema from "effect/Schema"
import { ProductId, VariantId } from "../Shared/Ids.ts"
import { Timestamp } from "../Shared/Refine.ts"
import { variants } from "../Sql/Catalog.ts"

/**
 * A size, shade or pack count of one Product. The name is unique within the
 * Product ignoring case; the database enforces it, core trims it first.
 */
export const Variant = createSelectSchema(variants, {
  id: VariantId,
  productId: ProductId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Variant = typeof Variant.Type

export const VariantInsert = createInsertSchema(variants, {
  id: Schema.optionalKey(VariantId),
  productId: ProductId,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type VariantInsert = typeof VariantInsert.Type

export const VariantUpdate = createUpdateSchema(variants, {
  id: Schema.optionalKey(VariantId),
  productId: Schema.optionalKey(ProductId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type VariantUpdate = typeof VariantUpdate.Type
