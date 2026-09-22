import { BrandNotFound } from "@app/protocol/brands"
import { RetailerNotFound } from "@app/protocol/retailers"
import { ListingNotFound } from "@app/protocol/listings"
import { PageNotFound } from "@app/protocol/pages"
import { ParentInFlight, ScrapeNotFound } from "@app/protocol/scrapes"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ProductNotFound } from "@app/protocol/products"
import { Scrapes } from "@app/core/scrapes"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { defaultLimit, page, parseCursor } from "@app/protocol/pagination"
import { Api } from "@app/protocol/api"
import { toWire } from "@app/protocol/scrape-wire"

export const ScrapesHandlersLayer = HttpApiBuilder.group(
  Api,
  "scrapes",
  (handlers) =>
    Effect.gen(function* () {
      const scrapes = yield* Scrapes.Service

      return handlers
        .handle("list", ({ query }) =>
          scrapes
            .list({
              listingId: query.listingId,
              pageId: query.pageId,
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
                Effect.logError("Scrapes.list persistence failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
              ),
            ),
        )
        .handle("get", ({ params }) =>
          scrapes.get({ scrapeId: params.id }).pipe(
            Effect.catchTag("ScrapeNotFound", (error) =>
              Effect.fail(new ScrapeNotFound({ scrapeId: error.scrapeId })),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Scrapes.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("content", ({ params }) =>
          scrapes.content({ scrapeId: params.id }).pipe(
            Effect.catchTag("ScrapeNotFound", (error) =>
              Effect.fail(new ScrapeNotFound({ scrapeId: error.scrapeId })),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ScrapeNotFound({ scrapeId: params.id })),
                onSome: Effect.succeed,
              }),
            ),
            Effect.catchTags({
              SqlError: () =>
                Effect.logError("Scrapes.content persistence failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
              StorageError: () =>
                Effect.logError("Scrapes.content storage failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
            }),
          ),
        )
        .handle("trigger", ({ payload }) =>
          scrapes.trigger(payload).pipe(
            Effect.catchTag("ListingNotFound", (error) =>
              Effect.fail(new ListingNotFound({ listingId: error.listingId })),
            ),
            Effect.catchTag("PageNotFound", (error) =>
              Effect.fail(new PageNotFound({ pageId: error.pageId })),
            ),
            Effect.catchTag("ParentInFlight", (error) =>
              Effect.fail(
                new ParentInFlight({
                  parent: error.parent,
                  scrapeId: error.scrapeId,
                }),
              ),
            ),
            Effect.map(toWire),
            // The row is committed; a Workflow that will not start is ours, not
            // the caller's, and the Cron's drain picks the Scrape up again.
            Effect.catchTags({
              SqlError: () =>
                Effect.logError("Scrapes.trigger persistence failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
              ExecutionsError: () =>
                Effect.logError("Scrapes.trigger dispatch failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
            }),
          ),
        )
        .handle("bulk", ({ payload }) =>
          scrapes.bulk(payload).pipe(
            Effect.catchTag("BrandNotFound", (error) =>
              Effect.fail(new BrandNotFound({ brandId: error.brandId })),
            ),
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.map((report) => ({
              created: report.created.length,
              skippedInFlight: report.skipped.length,
              skippedPaused: report.skippedPaused.length,
            })),
            Effect.catchTag("ProductNotFound", (error) =>
              Effect.fail(new ProductNotFound({ productId: error.productId })),
            ),
            Effect.catchTags({
              SqlError: () =>
                Effect.logError("Scrapes.bulk persistence failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
              ExecutionsError: () =>
                Effect.logError("Scrapes.bulk dispatch failed").pipe(
                  Effect.as(HttpServerResponse.empty({ status: 500 })),
                ),
            }),
          ),
        )
    }),
)
