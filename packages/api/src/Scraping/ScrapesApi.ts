import {
  BulkScrape,
  TriggerScrape,
} from "@digital-shelf/domain/Scraping/ScrapingManagement"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as CatalogErrors from "../Catalog/Errors.ts"
import * as Errors from "./Errors.ts"
import * as Wire from "./ScrapesWire.ts"

/**
 * Dispatch is command-shaped and answers `202 Accepted`: the row exists, the
 * Execution has been asked to start, and the outcome arrives on the row later.
 * A Parent already in flight is refused rather than queued; a Scrape is never
 * moved back out of a terminal status, so a rerun is a new `POST /scrapes`.
 */
export class ScrapesApi extends HttpApiGroup.make("scrapes").add(
  HttpApiEndpoint.get("list", "/scrapes", {
    query: Wire.ScrapesQuery,
    success: Wire.ScrapeList,
  }),
  HttpApiEndpoint.get("get", "/scrapes/:id", {
    params: Wire.IdParams,
    success: Wire.ScrapeWire,
    error: [Errors.ScrapeNotFound],
  }),
  HttpApiEndpoint.get("content", "/scrapes/:id/content", {
    params: Wire.IdParams,
    success: Wire.ScrapeContent,
    // The content is gone once retention has taken the object, whether or not
    // the Scrape row itself is still there (ADR 0001).
    error: [Errors.ScrapeNotFound],
  }),
  HttpApiEndpoint.post("trigger", "/scrapes", {
    payload: TriggerScrape,
    success: Wire.ScrapeWire.pipe(HttpApiSchema.status(202)),
    error: [
      CatalogErrors.ListingNotFound,
      CatalogErrors.PageNotFound,
      Errors.ParentInFlight,
    ],
  }),
  HttpApiEndpoint.post("bulk", "/scrapes/bulk", {
    payload: BulkScrape,
    success: Wire.BulkScrapeReport.pipe(HttpApiSchema.status(202)),
    error: [
      CatalogErrors.BrandNotFound,
      CatalogErrors.ProductNotFound,
      CatalogErrors.RetailerNotFound,
    ],
  }),
) {}
