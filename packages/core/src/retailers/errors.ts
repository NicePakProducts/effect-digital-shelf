export * as RetailersErrors from "./errors"

import * as Data from "effect/Data"
import type { RetailerId, ListingId, PageId } from "@app/schema/ids"

export class NotFound extends Data.TaggedError("RetailerNotFound")<{
  readonly retailerId: RetailerId
}> {}

export class InvalidDomain extends Data.TaggedError("InvalidRetailerDomain")<{
  readonly input: string
}> {}

export class DomainTaken extends Data.TaggedError("RetailerDomainTaken")<{
  readonly domain: string
  readonly retailerId: RetailerId
}> {}

export class UrlHostMismatch extends Data.TaggedError("UrlHostMismatch")<{
  readonly url: string
  readonly domain: string
  readonly listingIds: ReadonlyArray<ListingId>
  readonly pageIds: ReadonlyArray<PageId>
}> {}
