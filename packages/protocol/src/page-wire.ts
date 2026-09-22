import { TimestampWire } from "./timestamp"
import { Page } from "@app/schema/page"
import { PageId, BrandId, RetailerId } from "@app/schema/ids"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const PageWire = Schema.Struct({
  ...Page.WithStatus.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
  lastScrapedAt: Schema.NullOr(TimestampWire),
})

export type PageWire = typeof PageWire.Type

export const toWire = (entity: Page.WithStatus): PageWire => ({
  ...entity,
  lastScrapedAt: Option.getOrNull(entity.lastScrapedAt),
})

export const PageList = Schema.Struct({ items: Schema.Array(PageWire) })

export const IdParams = Schema.Struct({ id: PageId })

export const PagesQuery = Schema.Struct({
  brandId: Schema.optionalKey(BrandId),
  retailerId: Schema.optionalKey(RetailerId),
})
