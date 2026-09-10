import {
  BulkReExtract,
  TriggerExtraction,
} from "@digital-shelf/domain/Scraping/ScrapingManagement"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as CatalogErrors from "../Catalog/Errors.ts"
import * as Errors from "./Errors.ts"
import * as Wire from "./ExtractionsWire.ts"

/**
 * Re-extraction and the latest extracted data. Only a successful Scrape whose
 * HTML is still retained can be re-extracted, so a Scrape that never succeeded
 * or has passed retention is refused with `422`. The latest reads answer the
 * last good data, which survives newer failed Scrapes and Extractions.
 */
export class ExtractionsApi extends HttpApiGroup.make("extractions").add(
  HttpApiEndpoint.get("list", "/extractions", {
    query: Wire.ExtractionsQuery,
    success: Wire.ExtractionList,
  }),
  HttpApiEndpoint.get("get", "/extractions/:id", {
    params: Wire.IdParams,
    success: Wire.ExtractionWire,
    error: [Errors.ExtractionNotFound],
  }),
  HttpApiEndpoint.post("trigger", "/extractions", {
    payload: TriggerExtraction,
    success: Wire.ExtractionWire.pipe(HttpApiSchema.status(202)),
    error: [
      Errors.ScrapeNotFound,
      CatalogErrors.ListingNotFound,
      CatalogErrors.PageNotFound,
      Errors.NoSuccessfulScrape,
      Errors.ExtractionInFlight,
      Errors.ScrapeNotReExtractable,
    ],
  }),
  HttpApiEndpoint.post("bulk", "/extractions/bulk", {
    payload: BulkReExtract,
    success: Wire.BulkReExtractReport.pipe(HttpApiSchema.status(202)),
    error: [CatalogErrors.RetailerNotFound],
  }),
  HttpApiEndpoint.get("latestForListing", "/listings/:id/latest-extraction", {
    params: Wire.ListingIdParams,
    success: Wire.LatestExtractedDataWire,
    error: [Errors.NoExtractedData],
  }),
  HttpApiEndpoint.get("latestForPage", "/pages/:id/latest-extraction", {
    params: Wire.PageIdParams,
    success: Wire.LatestExtractedDataWire,
    error: [Errors.NoExtractedData],
  }),
  HttpApiEndpoint.get("latestForProduct", "/products/:id/latest-extractions", {
    params: Wire.ProductIdParams,
    success: Wire.LatestExtractedDataList,
  }),
) {}
