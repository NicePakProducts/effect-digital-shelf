import { TimestampWire } from "../TimestampWire.ts"
import { Brand } from "@digital-shelf/domain/Catalog/Brand"
import { BrandId } from "@digital-shelf/domain/Shared/Ids"
import * as Schema from "effect/Schema"

/** Catalog rows are whole on the wire, with ISO timestamps and nullable readings. */
export const BrandWire = Schema.Struct({
  ...Brand.fields,
  createdAt: TimestampWire,
  updatedAt: TimestampWire,
})
export type BrandWire = typeof BrandWire.Type
export const toWire = (entity: Brand): BrandWire => ({
  ...entity,
})
export const BrandList = Schema.Struct({ items: Schema.Array(BrandWire) })
export const IdParams = Schema.Struct({ id: BrandId })
