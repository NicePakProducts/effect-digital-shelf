import { TimestampWire } from "../TimestampWire.ts"
import { ListingWithStatus } from "@digital-shelf/domain/Catalog/Listing"
import {
  ListingId,
  ProductId,
  RetailerId,
} from "@digital-shelf/domain/Shared/Ids"
import * as Schema from "effect/Schema"
import * as Option from "effect/Option"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const ListingWire = Schema.Struct({
  ...ListingWithStatus.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
  lastScrapedAt: Schema.NullOr(TimestampWire),
})

export type ListingWire = typeof ListingWire.Type

export const toWire = (entity: ListingWithStatus): ListingWire => ({
  ...entity,
  lastScrapedAt: Option.getOrNull(entity.lastScrapedAt),
})

export const ListingList = Schema.Struct({ items: Schema.Array(ListingWire) })

export const IdParams = Schema.Struct({ id: ListingId })

export const ListingsQuery = Schema.Struct({
  productId: Schema.optionalKey(ProductId),
  retailerId: Schema.optionalKey(RetailerId),
})
