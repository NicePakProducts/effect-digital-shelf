import { TimestampWire } from "../TimestampWire.ts"
import { PageWithStatus } from "@digital-shelf/domain/Catalog/Page"
import { PageId, BrandId, RetailerId } from "@digital-shelf/domain/Shared/Ids"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const PageWire = Schema.Struct({
  ...PageWithStatus.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
  lastScrapedAt: Schema.NullOr(TimestampWire),
})
export type PageWire = typeof PageWire.Type
export const toWire = (entity: PageWithStatus): PageWire => ({
  ...entity,
  lastScrapedAt: Option.getOrNull(entity.lastScrapedAt),
})
export const PageList = Schema.Struct({ items: Schema.Array(PageWire) })
export const IdParams = Schema.Struct({ id: PageId })
export const PagesQuery = Schema.Struct({
  brandId: Schema.optionalKey(BrandId),
  retailerId: Schema.optionalKey(RetailerId),
})
