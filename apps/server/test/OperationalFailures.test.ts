import { expect, it } from "@effect/vitest"
import { Scrape } from "@app/schema/scrape"
import { Extraction } from "@app/schema/extraction"
import { Scrapes } from "@app/core/scrapes"
import { Extractions } from "@app/core/scrapes/extractions"
import { R2BucketTest } from "@app/core/test/layers/R2Bucket"
import { ExecutionsTest } from "@app/core/test/layers/Executions"
import { reset, seed, successfulScrape } from "@app/core/test/fixtures/Scraping"
import { Db } from "@app/db"
import { Effect, Exit, Layer, Logger, Option, Schema } from "effect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { Api } from "@app/protocol/api"
import * as ApiTest from "./layers/Api"

it.layer(ApiTest.TestLayer, { timeout: "60 seconds" })(
  "Operational HTTP failures",
  (it) => {
    it.effect(
      "returns empty 500 without defects and logs only the failing operation",
      () =>
        Effect.gen(function* () {
          const db = yield* Db
          const messages: unknown[] = []

          const DiagnosticsLayer = Logger.layer([
            Logger.make((options) => {
              messages.push(options.message)
            }),
          ])

          const context =
            yield* Effect.context<Layer.Success<typeof ApiTest.TestLayer>>()

          const handler = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(Api).pipe(
              Layer.provide(Layer.succeedContext(context)),
            ),
          )

          const id = "00000000-0000-4000-8000-000000000404"

          const listingId = Schema.decodeUnknownSync(
            Scrape.Parent.members[0].fields.listingId,
          )(id)

          const brandId = Schema.decodeUnknownSync(
            Scrape.Bulk.members[0].fields.brandId,
          )(id)

          const scrapeId = Schema.decodeUnknownSync(
            Extraction.Trigger.members[0].fields.scrapeId,
          )(id)

          const requests = [
            { method: "GET", path: "products", operation: "Products.list" },
            {
              method: "GET",
              path: `products/${id}`,
              operation: "Products.get",
            },
            {
              method: "POST",
              path: "products",
              body: { brandId: id, name: "Product" },
              operation: "Products.create",
            },
            {
              method: "PATCH",
              path: `products/${id}`,
              body: { name: "Product" },
              operation: "Products.update",
            },
            {
              method: "GET",
              path: `products/${id}/impact`,
              operation: "Products.impact",
            },
            {
              method: "DELETE",
              path: `products/${id}`,
              operation: "Products.remove",
            },
            {
              method: "GET",
              path: "variants",
              operation: "ProductVariants.list",
            },
            {
              method: "GET",
              path: `variants/${id}`,
              operation: "ProductVariants.get",
            },
            {
              method: "POST",
              path: "variants",
              body: { productId: id, name: "Variant" },
              operation: "ProductVariants.create",
            },
            {
              method: "PATCH",
              path: `variants/${id}`,
              body: { name: "Variant" },
              operation: "ProductVariants.update",
            },
            {
              method: "DELETE",
              path: `variants/${id}`,
              operation: "ProductVariants.remove",
            },
            { method: "GET", path: `brands`, operation: "Brands.list" },
            { method: "GET", path: `brands/${id}`, operation: "Brands.get" },
            {
              method: "POST",
              path: `brands`,
              operation: "Brands.create",
              body: { name: "Brand" },
            },
            {
              method: "PATCH",
              path: `brands/${id}`,
              operation: "Brands.update",
              body: { name: "Brand" },
            },
            {
              method: "GET",
              path: `brands/${id}/impact`,
              operation: "Brands.impact",
            },
            {
              method: "DELETE",
              path: `brands/${id}`,
              operation: "Brands.remove",
            },
            { method: "GET", path: `retailers`, operation: "Retailers.list" },
            {
              method: "GET",
              path: `retailers/${id}`,
              operation: "Retailers.get",
            },
            {
              method: "POST",
              path: `retailers`,
              operation: "Retailers.create",
              body: { name: "Retailer", domain: "example.com" },
            },
            {
              method: "PATCH",
              path: `retailers/${id}`,
              operation: "Retailers.update",
              body: { name: "Retailer" },
            },
            {
              method: "GET",
              path: `retailers/${id}/impact`,
              operation: "Retailers.impact",
            },
            {
              method: "DELETE",
              path: `retailers/${id}`,
              operation: "Retailers.remove",
            },
            { method: "GET", path: `listings`, operation: "Listings.list" },
            {
              method: "GET",
              path: `listings/${id}`,
              operation: "Listings.get",
            },
            {
              method: "POST",
              path: `listings`,
              operation: "Listings.create",
              body: {
                productId: id,
                retailerId: id,
                url: "https://example.com/item",
              },
            },
            {
              method: "PATCH",
              path: `listings/${id}`,
              operation: "Listings.update",
              body: { url: "https://example.com/item" },
            },
            {
              method: "GET",
              path: `listings/${id}/impact`,
              operation: "Listings.impact",
            },
            {
              method: "DELETE",
              path: `listings/${id}`,
              operation: "Listings.remove",
            },
            { method: "GET", path: `pages`, operation: "Pages.list" },
            { method: "GET", path: `pages/${id}`, operation: "Pages.get" },
            {
              method: "POST",
              path: `pages`,
              operation: "Pages.create",
              body: {
                brandId: id,
                retailerId: id,
                url: "https://example.com/brand",
              },
            },
            {
              method: "PATCH",
              path: `pages/${id}`,
              operation: "Pages.update",
              body: { url: "https://example.com/brand" },
            },
            {
              method: "GET",
              path: `pages/${id}/impact`,
              operation: "Pages.impact",
            },
            {
              method: "DELETE",
              path: `pages/${id}`,
              operation: "Pages.remove",
            },
            { method: "GET", path: `scrapes`, operation: "Scrapes.list" },
            { method: "GET", path: `scrapes/${id}`, operation: "Scrapes.get" },
            {
              method: "GET",
              path: `scrapes/${id}/content`,
              operation: "Scrapes.content",
            },
            {
              method: "POST",
              path: `scrapes`,
              operation: "Scrapes.trigger",
              body: { parent: Scrape.Parent.members[0].make({ listingId }) },
            },
            {
              method: "POST",
              path: `scrapes/bulk`,
              operation: "Scrapes.bulk",
              body: Scrape.Bulk.members[0].make({ brandId }),
            },
            {
              method: "GET",
              path: `extractions`,
              operation: "Extractions.list",
            },
            {
              method: "GET",
              path: `extractions/${id}`,
              operation: "Extractions.get",
            },
            {
              method: "POST",
              path: `extractions`,
              operation: "Extractions.trigger",
              body: Extraction.Trigger.members[0].make({ scrapeId }),
            },
            {
              method: "POST",
              path: `extractions/bulk`,
              operation: "Extractions.bulk",
              body: { retailerId: id, promptKind: "listing" },
            },
            {
              method: "GET",
              path: `listings/${id}/latest-extraction`,
              operation: "Extractions.latestExtractedData",
            },
            {
              method: "GET",
              path: `pages/${id}/latest-extraction`,
              operation: "Extractions.latestExtractedData",
            },
            {
              method: "GET",
              path: `products/${id}/latest-extractions`,
              operation: "Extractions.latestForProduct",
            },
          ]

          expect(requests).toHaveLength(47)

          yield* db.transaction(() =>
            Effect.gen(function* () {
              // The real transaction remains aborted; every subsequent query fails.
              yield* db.execute("select 1 / 0").pipe(Effect.flip)

              for (const request of requests) {
                const exit = yield* Effect.exit(
                  handler.pipe(
                    Effect.provideService(
                      HttpServerRequest.HttpServerRequest,
                      HttpServerRequest.fromWeb(
                        new Request(`${ApiTest.baseUrl}/${request.path}`, {
                          method: request.method,
                          headers: { "content-type": "application/json" },
                          body:
                            request.body === undefined
                              ? null
                              : JSON.stringify(request.body),
                        }),
                      ),
                    ),
                    Effect.provide(DiagnosticsLayer),
                  ),
                )

                expect(Exit.isSuccess(exit), request.operation).toBe(true)

                if (Exit.isFailure(exit))
                  return yield* Effect.failCause(exit.cause)
                expect(exit.value.status).toBe(500)
                expect(exit.value.body._tag).toBe("Empty")
              }
            }),
          )
          expect(messages).toEqual(
            requests.map((request) => [
              `${request.operation} persistence failed`,
            ]),
          )
        }),
    )
    it.effect(
      "keeps committed dispatch rows without retry and handles storage failure without defects",
      () =>
        Effect.gen(function* () {
          const context =
            yield* Effect.context<Layer.Success<typeof ApiTest.TestLayer>>()

          const handler = yield* HttpRouter.toHttpEffect(
            HttpApiBuilder.layer(Api).pipe(
              Layer.provide(Layer.succeedContext(context)),
            ),
          )

          const executions = yield* ExecutionsTest
          const bucket = yield* R2BucketTest
          const scrapes = yield* Scrapes.Service
          const extractions = yield* Extractions.Service
          const messages: unknown[] = []

          const DiagnosticsLayer = Logger.layer([
            Logger.make((options) => {
              messages.push(options.message)
            }),
          ])

          for (const operation of [
            "Scrapes.trigger",
            "Scrapes.bulk",
            "Extractions.trigger",
            "Extractions.bulk",
            "Scrapes.content",
          ]) {
            yield* reset
            const fixture = yield* seed()
            const listing = yield* fixture.listing

            const scrape =
              operation.startsWith("Extractions") ||
              operation === "Scrapes.content"
                ? yield* successfulScrape(listing.parent)
                : undefined

            const body =
              operation === "Scrapes.trigger"
                ? { parent: listing.parent }
                : operation === "Scrapes.bulk"
                  ? Scrape.Bulk.members[0].make({ brandId: fixture.brandId })
                  : operation === "Extractions.trigger" && scrape !== undefined
                    ? Extraction.Trigger.members[0].make({
                        scrapeId: scrape.id,
                      })
                    : { retailerId: fixture.retailerId, promptKind: "listing" }

            const path =
              operation === "Scrapes.content" && scrape !== undefined
                ? `scrapes/${scrape.id}/content`
                : operation
                    .replace("Scrapes", "scrapes")
                    .replace("Extractions", "extractions")
                    .replace(".trigger", "")
                    .replace(".bulk", "/bulk")

            if (operation === "Scrapes.content") yield* bucket.failNextGet

            if (operation !== "Scrapes.content") yield* executions.failNext

            const exit = yield* Effect.exit(
              handler.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(
                    new Request(`${ApiTest.baseUrl}/${path}`, {
                      method: operation === "Scrapes.content" ? "GET" : "POST",
                      headers: { "content-type": "application/json" },
                      body:
                        operation === "Scrapes.content"
                          ? null
                          : JSON.stringify(body),
                    }),
                  ),
                ),
                Effect.provide(DiagnosticsLayer),
              ),
            )

            expect(Exit.isSuccess(exit), operation).toBe(true)

            if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause)
            expect(exit.value.status, operation).toBe(500)
            expect(exit.value.body._tag, operation).toBe("Empty")
            const calls = yield* executions.calls

            const scrapeRows = yield* scrapes.list({
              listingId: listing.parent.listingId,
              limit: 100,
            })

            expect(scrapeRows.items).toHaveLength(1)

            if (operation === "Scrapes.content") {
              expect(calls).toEqual([])
              expect(scrapeRows.items[0]?.status).toBe("success")
              // A read failure cannot delete the object or mutate its row.
              expect(
                yield* scrapes.content({ scrapeId: scrapeRows.items[0]!.id }),
              ).toEqual(Option.some("<p>Hello</p>"))
              continue
            }

            const rows = operation.startsWith("Extractions")
              ? (yield* extractions.list({ scrapeId: scrape!.id, limit: 100 }))
                  .items
              : scrapeRows.items

            expect(rows).toHaveLength(1)
            expect(rows[0]?.status).toBe("pending")
            expect(calls).toHaveLength(1)
            expect(calls[0]?.operation).toBe("start")
            expect(calls[0]?.kind).toBe(
              operation.startsWith("Extractions") ? "extraction" : "scrape",
            )
            expect(calls[0]?.instances.map((instance) => instance.id)).toEqual([
              rows[0]!.id,
            ])
          }

          expect(messages).toEqual([
            ["Scrapes.trigger dispatch failed"],
            ["Scrapes.bulk dispatch failed"],
            ["Extractions.trigger dispatch failed"],
            ["Extractions.bulk dispatch failed"],
            ["Scrapes.content storage failed"],
          ])
        }),
    )
  },
)
