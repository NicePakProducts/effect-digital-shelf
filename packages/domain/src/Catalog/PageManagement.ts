import * as Schema from "effect/Schema"
import { BrandId, RetailerId } from "../Shared/Ids.ts"
import { Url } from "../Shared/Refine.ts"
import { Cadence } from "./Cadence.ts"

export const CreatePage = Schema.Struct({
  brandId: BrandId,
  retailerId: RetailerId,
  url: Url,
  cadence: Schema.optionalKey(Cadence),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type CreatePage = typeof CreatePage.Type

export const UpdatePage = Schema.Struct({
  url: Schema.optionalKey(Url),
  cadence: Schema.optionalKey(Cadence),
  paused: Schema.optionalKey(Schema.Boolean),
})

export type UpdatePage = typeof UpdatePage.Type
