import { RetailerNotFound } from "@app/protocol/retailers"
import { ScrapeNotFound } from "@app/protocol/scrapes"
import { ListingNotFound } from "@app/protocol/listings"
import { PageNotFound } from "@app/protocol/pages"
import {
  NoSuccessfulScrape,
  ExtractionInFlight,
  ScrapeNotReExtractable,
  ExtractionNotFound,
  NoExtractedData,
} from "@app/protocol/extractions"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ProductNotFound } from "@app/protocol/products"
import { Extractions } from "@app/core/scrapes/extractions"
import { Scrape } from "@app/schema/scrape"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { defaultLimit, page, parseCursor } from "@app/protocol/pagination"
import { Api } from "@app/protocol/api"
import { toLatestWire, toWire } from "@app/protocol/extraction-wire"

export const ExtractionsHandlersLayer = HttpApiBuilder.group(
  Api,
  "extractions",
  (handlers) =>
    Effect.gen(function* () {
      const extractions = yield* Extractions.Service

      /** The latest reads answer 404 when the Parent has no successful Extraction. */
      const latest = (parent: Scrape.Parent) =>
        extractions.latestExtractedData({ parent }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NoExtractedData({ parent })),
              onSome: (data) => Effect.succeed(toLatestWire(data)),
            }),
          ),
          Effect.catchTag("SqlError", () =>
            Effect.logError(
              "Extractions.latestExtractedData persistence failed",
            ).pipe(Effect.as(HttpServerResponse.empty({ status: 500 }))),
          ),
        )

      return handlers
        .handle("list", ({ query }) =>
          extractions
            .list({
              scrapeId: query.scrapeId,
              status: query.status,
              cursor:
                query.cursor === undefined
                  ? undefined
                  : parseCursor(query.cursor),
              limit: query.limit ?? defaultLimit,
            })
            .pipe(
              Effect.map((result) => page(result, toWire)),
              Effect.catchTag("SqlError", () =>
                Effect.logError("Extractions.list persistence failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
              ),
            ),
        )
        .handle("get", ({ params }) =>
          extractions.get({ extractionId: params.id }).pipe(
            Effect.catchTag("ExtractionNotFound", (error) =>
              Effect.fail(
                new ExtractionNotFound({ extractionId: error.extractionId }),
              ),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Extractions.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("trigger", ({ payload }) =>
          extractions.trigger(payload).pipe(
            Effect.catchTag("ScrapeNotFound", (error) =>
              Effect.fail(new ScrapeNotFound({ scrapeId: error.scrapeId })),
            ),
            Effect.catchTag("ListingNotFound", (error) =>
              Effect.fail(new ListingNotFound({ listingId: error.listingId })),
            ),
            Effect.catchTag("PageNotFound", (error) =>
              Effect.fail(new PageNotFound({ pageId: error.pageId })),
            ),
            Effect.catchTag("NoSuccessfulScrape", (error) =>
              Effect.fail(new NoSuccessfulScrape({ parent: error.parent })),
            ),
            Effect.catchTag("ExtractionInFlight", (error) =>
              Effect.fail(
                new ExtractionInFlight({
                  scrapeId: error.scrapeId,
                  promptKind: error.promptKind,
                  extractionId: error.extractionId,
                }),
              ),
            ),
            Effect.catchTag("ScrapeNotReExtractable", (error) =>
              Effect.fail(
                new ScrapeNotReExtractable({
                  scrapeId: error.scrapeId,
                  reason: error.reason,
                }),
              ),
            ),
            Effect.map(toWire),
            // The row is committed; a Workflow that will not start is ours, not
            // the caller's, and the Cron's drain picks the Extraction up again.
            Effect.catchTags({
              SqlError: () =>
                Effect.logError("Extractions.trigger persistence failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
              ExecutionsError: () =>
                Effect.logError("Extractions.trigger dispatch failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
            }),
          ),
        )
        .handle("bulk", ({ payload }) =>
          extractions.bulk(payload).pipe(
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.map((report) => ({
              created: report.created.length,
              skipped: report.skipped,
            })),
            Effect.catchTags({
              SqlError: () =>
                Effect.logError("Extractions.bulk persistence failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
              ExecutionsError: () =>
                Effect.logError("Extractions.bulk dispatch failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
            }),
          ),
        )
        .handle("latestForListing", ({ params }) =>
          latest(Scrape.Parent.members[0].make({ listingId: params.id })),
        )
        .handle("latestForPage", ({ params }) =>
          latest(Scrape.Parent.members[1].make({ pageId: params.id })),
        )
        .handle("latestForProduct", ({ params }) =>
          extractions
            .latestExtractedDataForProduct({ productId: params.id })
            .pipe(
              Effect.map((rows) => ({ items: rows.map(toLatestWire) })),
              Effect.catchTag("ProductNotFound", (error) =>
                Effect.fail(
                  new ProductNotFound({ productId: error.productId }),
                ),
              ),
              Effect.catchTag("SqlError", () =>
                Effect.logError(
                  "Extractions.latestForProduct persistence failed",
                ).pipe(Effect.as(HttpServerResponse.empty({ status: 500 }))),
              ),
            ),
        )
    }),
)
