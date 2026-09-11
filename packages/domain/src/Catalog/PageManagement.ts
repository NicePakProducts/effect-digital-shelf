import * as Schema from "effect/Schema"
import { BrandId, RetailerId, PageId } from "../Shared/Ids.ts"
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

export const GetPageInput = Schema.Struct({ pageId: PageId })

export type GetPageInput = typeof GetPageInput.Type

export const RemovePageInput = Schema.Struct({ pageId: PageId })

export type RemovePageInput = typeof RemovePageInput.Type

export const PageImpactInput = Schema.Struct({ pageId: PageId })

export type PageImpactInput = typeof PageImpactInput.Type

export const UpdatePageInput = Schema.Struct({
  pageId: PageId,
  command: UpdatePage,
})

export type UpdatePageInput = typeof UpdatePageInput.Type
