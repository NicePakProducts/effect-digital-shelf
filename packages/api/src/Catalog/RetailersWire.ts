import { TimestampWire } from "../TimestampWire.ts"
import { Retailer } from "@digital-shelf/domain/Catalog/Retailer"
import { RetailerId } from "@digital-shelf/domain/Shared/Ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const RetailerWire = Schema.Struct({
  ...Retailer.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})

export type RetailerWire = typeof RetailerWire.Type

export const toWire = (entity: Retailer): RetailerWire => ({
  ...entity,
})

export const RetailerList = Schema.Struct({ items: Schema.Array(RetailerWire) })

export const IdParams = Schema.Struct({ id: RetailerId })
