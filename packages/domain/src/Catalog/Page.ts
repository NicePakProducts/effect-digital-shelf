import { CombinedStatus } from "../Scraping/Vocabulary.ts"
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Schema from "effect/Schema"
import { BrandId, PageId, RetailerId } from "../Shared/Ids.ts"
import { Timestamp, nullable } from "../Shared/Refine.ts"
import { pages } from "../Sql/Catalog.ts"

/** A Brand's storefront or brand page on a Retailer, unique per pair. */
export const Page = createSelectSchema(pages, {
  id: PageId,
  brandId: BrandId,
  retailerId: RetailerId,
  lastScrapedAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Page = typeof Page.Type

export const PageInsert = createInsertSchema(pages, {
  id: Schema.optionalKey(PageId),
  brandId: BrandId,
  retailerId: RetailerId,
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type PageInsert = typeof PageInsert.Type

export const PageUpdate = createUpdateSchema(pages, {
  id: Schema.optionalKey(PageId),
  brandId: Schema.optionalKey(BrandId),
  retailerId: Schema.optionalKey(RetailerId),
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type PageUpdate = typeof PageUpdate.Type

/** A Page as the api reads it, with its derived pause and status readings. */
export const PageWithStatus = Schema.Struct({
  ...Page.fields,

  effectivePaused: Schema.Boolean,
  combinedStatus: CombinedStatus,
})
export type PageWithStatus = typeof PageWithStatus.Type
