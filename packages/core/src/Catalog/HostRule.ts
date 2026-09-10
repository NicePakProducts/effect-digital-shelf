import { UrlHostMismatch } from "@digital-shelf/domain/Catalog/Errors"
import {
  hostMatches,
  type RetailerDomain,
} from "@digital-shelf/domain/Catalog/Retailer"
import type { ListingId, PageId } from "@digital-shelf/domain/Shared/Ids"
import * as Effect from "effect/Effect"

/**
 * The host rule as the Catalog features raise it: a Listing or Page URL must
 * sit on its Retailer's domain, and a write that would break that is refused
 * rather than flagged. The caller reads the Retailer row under a lock first
 * (`FOR SHARE` on a child write, `FOR UPDATE` on a domain change), so the
 * domain checked here is the domain the transaction will see committed.
 *
 * `offender` names the rows already stored that a domain change would
 * invalidate; a child write has none to name, since the row it refuses is the
 * one it was about to write.
 */
export const requireHostMatch = (
  url: string,
  domain: RetailerDomain,
  offender: {
    readonly listingIds?: ReadonlyArray<ListingId>
    readonly pageIds?: ReadonlyArray<PageId>
  } = {},
): Effect.Effect<void, UrlHostMismatch> =>
  hostMatches(url, domain)
    ? Effect.void
    : Effect.fail(
        new UrlHostMismatch({
          url,
          domain,
          listingIds: offender.listingIds ?? [],
          pageIds: offender.pageIds ?? [],
        }),
      )
