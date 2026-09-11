import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Schema from "effect/Schema"
import { BrandId } from "../Shared/Ids.ts"
import { Timestamp } from "../Shared/Refine.ts"
import { brands } from "../Sql/Catalog.ts"

/** A top-level commercial identity. Sub-brands are separate Brands. */
export const Brand = createSelectSchema(brands, {
  id: BrandId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Brand = typeof Brand.Type

export const BrandInsert = createInsertSchema(brands, {
  id: Schema.optionalKey(BrandId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type BrandInsert = typeof BrandInsert.Type

export const BrandUpdate = createUpdateSchema(brands, {
  id: Schema.optionalKey(BrandId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type BrandUpdate = typeof BrandUpdate.Type
