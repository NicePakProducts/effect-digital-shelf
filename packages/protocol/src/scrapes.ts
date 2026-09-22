import * as Schema from "effect/Schema"
import { ScrapeId } from "@app/schema/ids"
import { Scrape } from "@app/schema/scrape"
import { ListingNotFound } from "./listings"
import { PageNotFound } from "./pages"
import { BrandNotFound } from "./brands"
import { RetailerNotFound } from "./retailers"
import { ProductNotFound } from "./products"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./scrape-wire"

/**
 * Dispatch is command-shaped and answers `202 Accepted`: the row exists, the
 * Execution has been asked to start, and the outcome arrives on the row later.
 * A Parent already in flight is refused rather than queued; a Scrape is never
 * moved back out of a terminal status, so a rerun is a new `POST /scrapes`.
 */
export class ScrapeNotFound extends Schema.TaggedError<ScrapeNotFound>()(
  "ScrapeNotFound",
  { scrapeId: ScrapeId },
  { httpApiStatus: 404 },
) {}

export class ParentInFlight extends Schema.TaggedError<ParentInFlight>()(
  "ParentInFlight",
  { parent: Scrape.Parent, scrapeId: ScrapeId },
  { httpApiStatus: 409 },
) {}

export class ScrapesApi extends HttpApiGroup.make("scrapes").add(
  HttpApiEndpoint.get("list", "/scrapes", {
    query: Wire.ScrapesQuery,
    success: Wire.ScrapeList,
  }),
  HttpApiEndpoint.get("get", "/scrapes/:id", {
    params: Wire.IdParams,
    success: Wire.ScrapeWire,
    error: [ScrapeNotFound],
  }),
  HttpApiEndpoint.get("content", "/scrapes/:id/content", {
    params: Wire.IdParams,
    success: Wire.ScrapeContent,
    // The content is gone once retention has taken the object, whether or not
    // the Scrape row itself is still there (ADR 0001).
    error: [ScrapeNotFound],
  }),
  HttpApiEndpoint.post("trigger", "/scrapes", {
    payload: Scrape.Trigger,
    success: Wire.ScrapeWire.pipe(HttpApiSchema.status(202)),
    error: [ListingNotFound, PageNotFound, ParentInFlight],
  }),
  HttpApiEndpoint.post("bulk", "/scrapes/bulk", {
    payload: Scrape.Bulk,
    success: Wire.BulkScrapeReport.pipe(HttpApiSchema.status(202)),
    error: [BrandNotFound, ProductNotFound, RetailerNotFound],
  }),
) {}
