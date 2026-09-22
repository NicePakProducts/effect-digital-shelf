export * as PagesErrors from "./errors"

import * as Data from "effect/Data"
import type { PageId, BrandId, RetailerId } from "@app/schema/ids"

export class NotFound extends Data.TaggedError("PageNotFound")<{
  readonly pageId: PageId
}> {}

export class AlreadyExists extends Data.TaggedError("PageAlreadyExists")<{
  readonly brandId: BrandId
  readonly retailerId: RetailerId
  readonly pageId: PageId
}> {}
