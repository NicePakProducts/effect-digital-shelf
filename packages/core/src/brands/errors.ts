export * as BrandsErrors from "./errors"

import * as Data from "effect/Data"
import type { BrandId } from "@app/schema/ids"

export class NotFound extends Data.TaggedError("BrandNotFound")<{
  readonly brandId: BrandId
}> {}
