import { TimestampWire } from "./timestamp"
import { Retailer } from "@app/schema/retailer"
import { RetailerId } from "@app/schema/ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const RetailerWire = Schema.Struct({
  ...Retailer.Info.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})

export type RetailerWire = typeof RetailerWire.Type

export const toWire = (entity: Retailer.Info): RetailerWire => ({
  ...entity,
})

export const RetailerList = Schema.Struct({ items: Schema.Array(RetailerWire) })

export const IdParams = Schema.Struct({ id: RetailerId })
