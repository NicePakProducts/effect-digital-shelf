import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import * as Schema from "effect/Schema"
import { RetailerId } from "../Shared/Ids.ts"
import { Timestamp } from "../Shared/Refine.ts"
import { retailers } from "../Sql/Catalog.ts"

/**
 * A canonical host: lower-case, no scheme, path, port or leading `www.`, and
 * at least one dot. Core derives it from whatever the user pasted
 * (`RetailerManagement.CreateRetailer.domain`); this is the stored form.
 */
export const RetailerDomain = Schema.String.check(
  Schema.isPattern(/^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/, {
    identifier: "RetailerDomain",
    description: "a canonical host such as chemistwarehouse.com.au",
  }),
).pipe(Schema.brand("RetailerDomain"))
export type RetailerDomain = typeof RetailerDomain.Type

/** A destination domain we scrape, global and shared across all Brands. */
export const Retailer = createSelectSchema(retailers, {
  id: RetailerId,
  domain: RetailerDomain,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})
export type Retailer = typeof Retailer.Type

export const RetailerInsert = createInsertSchema(retailers, {
  id: Schema.optionalKey(RetailerId),
  domain: RetailerDomain,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type RetailerInsert = typeof RetailerInsert.Type

export const RetailerUpdate = createUpdateSchema(retailers, {
  id: Schema.optionalKey(RetailerId),
  domain: Schema.optionalKey(RetailerDomain),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})
export type RetailerUpdate = typeof RetailerUpdate.Type
