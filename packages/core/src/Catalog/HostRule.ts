import { UrlHostMismatch } from "@digital-shelf/domain/Catalog/Errors"
import {
  hostMatches,
  type RetailerDomain,
} from "@digital-shelf/domain/Catalog/Retailer"
import * as Effect from "effect/Effect"

/**
 * The host rule as a child write raises it: a Listing or Page URL must sit on
 * its Retailer's domain, and a write that would break that is refused rather
 * than flagged. The caller reads the Retailer row `FOR SHARE` first, so the
 * domain checked here is the domain the transaction will see committed. The
 * error names no rows: the one it refuses is the one about to be written,
 * and only a Retailer domain change (Retailers.ts) has stored rows to name.
 */
export const requireHostMatch = (
  url: string,
  domain: RetailerDomain,
): Effect.Effect<void, UrlHostMismatch> =>
  hostMatches(url, domain)
    ? Effect.void
    : Effect.fail(
        new UrlHostMismatch({ url, domain, listingIds: [], pageIds: [] }),
      )
