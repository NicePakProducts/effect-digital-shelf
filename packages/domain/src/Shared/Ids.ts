import * as Schema from "effect/Schema"

/**
 * Entity identities. Every id is an opaque UUID string branded per entity so a
 * ProductId can never be passed where a BrandId is expected. New rows are minted
 * by the table's `$defaultFn` (see Sql/Columns.ts); migrated InstantDB UUIDs
 * pass unchanged.
 */
const Uuid = Schema.String.check(Schema.isUUID())

export const BrandId = Uuid.pipe(Schema.brand("BrandId"))
export type BrandId = typeof BrandId.Type

export const ProductId = Uuid.pipe(Schema.brand("ProductId"))
export type ProductId = typeof ProductId.Type

export const VariantId = Uuid.pipe(Schema.brand("VariantId"))
export type VariantId = typeof VariantId.Type

export const RetailerId = Uuid.pipe(Schema.brand("RetailerId"))
export type RetailerId = typeof RetailerId.Type

export const ListingId = Uuid.pipe(Schema.brand("ListingId"))
export type ListingId = typeof ListingId.Type

export const PageId = Uuid.pipe(Schema.brand("PageId"))
export type PageId = typeof PageId.Type

export const ScrapeId = Uuid.pipe(Schema.brand("ScrapeId"))
export type ScrapeId = typeof ScrapeId.Type

export const ExtractionId = Uuid.pipe(Schema.brand("ExtractionId"))
export type ExtractionId = typeof ExtractionId.Type
