import { TimestampWire } from "./timestamp"
import { Brand } from "@app/schema/brand"
import { BrandId } from "@app/schema/ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const BrandWire = Schema.Struct({
  ...Brand.Info.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})

export type BrandWire = typeof BrandWire.Type

export const toWire = (entity: Brand.Info): BrandWire => ({
  ...entity,
})

export const BrandList = Schema.Struct({ items: Schema.Array(BrandWire) })

export const IdParams = Schema.Struct({ id: BrandId })
