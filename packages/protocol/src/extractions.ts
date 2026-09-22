import * as Schema from "effect/Schema"
import { ExtractionId, ScrapeId } from "@app/schema/ids"
import { Scrape } from "@app/schema/scrape"
import { PromptKind } from "@app/schema/scraping-vocabulary"
import { ListingNotFound } from "./listings"
import { PageNotFound } from "./pages"
import { RetailerNotFound } from "./retailers"
import { ScrapeNotFound } from "./scrapes"
import { ProductNotFound } from "./products"
import { Extraction } from "@app/schema/extraction"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./extraction-wire"

/**
 * Re-extraction and the latest extracted data. Only a successful Scrape whose
 * HTML is still retained can be re-extracted, so a Scrape that never succeeded
 * or has passed retention is refused with `422`. The latest reads answer the
 * last good data, which survives newer failed Scrapes and Extractions; a
 * Product that exists but has none answers an empty list, an unknown one `404`.
 */
export class ExtractionNotFound extends Schema.TaggedError<ExtractionNotFound>()(
  "ExtractionNotFound",
  { extractionId: ExtractionId },
  { httpApiStatus: 404 },
) {}

export class ScrapeNotReExtractable extends Schema.TaggedError<ScrapeNotReExtractable>()(
  "ScrapeNotReExtractable",
  {
    scrapeId: ScrapeId,
    reason: Schema.Literals(["not_successful", "html_expired"]),
  },
  { httpApiStatus: 422 },
) {}

export class ExtractionInFlight extends Schema.TaggedError<ExtractionInFlight>()(
  "ExtractionInFlight",
  { scrapeId: ScrapeId, promptKind: PromptKind, extractionId: ExtractionId },
  { httpApiStatus: 409 },
) {}

export class NoSuccessfulScrape extends Schema.TaggedError<NoSuccessfulScrape>()(
  "NoSuccessfulScrape",
  { parent: Scrape.Parent },
  { httpApiStatus: 404 },
) {}

export class NoExtractedData extends Schema.TaggedError<NoExtractedData>()(
  "NoExtractedData",
  { parent: Scrape.Parent },
  { httpApiStatus: 404 },
) {}

export class ExtractionsApi extends HttpApiGroup.make("extractions").add(
  HttpApiEndpoint.get("list", "/extractions", {
    query: Wire.ExtractionsQuery,
    success: Wire.ExtractionList,
  }),
  HttpApiEndpoint.get("get", "/extractions/:id", {
    params: Wire.IdParams,
    success: Wire.ExtractionWire,
    error: [ExtractionNotFound],
  }),
  HttpApiEndpoint.post("trigger", "/extractions", {
    payload: Extraction.Trigger,
    success: Wire.ExtractionWire.pipe(HttpApiSchema.status(202)),
    error: [
      ScrapeNotFound,
      ListingNotFound,
      PageNotFound,
      NoSuccessfulScrape,
      ExtractionInFlight,
      ScrapeNotReExtractable,
    ],
  }),
  HttpApiEndpoint.post("bulk", "/extractions/bulk", {
    payload: Extraction.Bulk,
    success: Wire.BulkReExtractReport.pipe(HttpApiSchema.status(202)),
    error: [RetailerNotFound],
  }),
  HttpApiEndpoint.get("latestForListing", "/listings/:id/latest-extraction", {
    params: Wire.ListingIdParams,
    success: Wire.LatestExtractedDataWire,
    error: [NoExtractedData],
  }),
  HttpApiEndpoint.get("latestForPage", "/pages/:id/latest-extraction", {
    params: Wire.PageIdParams,
    success: Wire.LatestExtractedDataWire,
    error: [NoExtractedData],
  }),
  HttpApiEndpoint.get("latestForProduct", "/products/:id/latest-extractions", {
    params: Wire.ProductIdParams,
    success: Wire.LatestExtractedDataList,
    error: [ProductNotFound],
  }),
) {}
