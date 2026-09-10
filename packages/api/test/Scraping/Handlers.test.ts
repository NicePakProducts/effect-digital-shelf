import { expect, it } from "@effect/vitest"
import { R2BucketTest } from "@digital-shelf/core/test/layers/R2Bucket"
import {
  extraction,
  history,
  reset,
  seed,
  successfulScrape,
} from "@digital-shelf/core/test/fixtures/Scraping"
import { RootApi } from "@digital-shelf/api/RootApi"
import {
  ListingId,
  PageId,
  ProductId,
  ScrapeId,
} from "@digital-shelf/domain/Shared/Ids"
import { DateTime, Effect, Option, Schema } from "effect"
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest"
import * as TestClock from "effect/testing/TestClock"
import * as ApiTest from "../layers/Api.ts"

const client = HttpApiTest.groups(RootApi, ["scrapes", "extractions"])
const missing = "00000000-0000-4000-8000-000000000404"
const missingListingId = Schema.decodeUnknownSync(ListingId)(missing)
const missingPageId = Schema.decodeUnknownSync(PageId)(missing)
const missingProductId = Schema.decodeUnknownSync(ProductId)(missing)
const missingScrapeId = Schema.decodeUnknownSync(ScrapeId)(missing)

const cursorOf = (row: {
  readonly createdAt: DateTime.Utc
  readonly id: string
}) => `${DateTime.toEpochMillis(row.createdAt)}:${row.id}`

it.layer(ApiTest.layerTest, { timeout: "60 seconds" })(
  "Scraping handlers",
  (it) => {
    it.effect(
      "POST /scrapes answers 202 without the R2 keys and refuses an in-flight Parent with 409",
      () =>
        Effect.gen(function* () {
          yield* reset
          const { parent } = yield* (yield* seed()).listing
          const api = yield* client
          const [row, response] = yield* api.scrapes.trigger({
            payload: { parent },
            responseMode: "decoded-and-response",
          })
          expect(response.status).toBe(202)
          expect(row.status).toBe("pending")
          expect(row.listingId).toBe(parent.listingId)
          expect(row.pageId).toBe(null)
          const body = (yield* response.json) as Record<string, unknown>
          expect(Object.keys(body)).not.toContain("htmlR2Key")
          expect(Object.keys(body)).not.toContain("rawR2Key")
          expect(body["createdAt"]).toBe(DateTime.formatIso(row.createdAt))
          const conflict = yield* api.scrapes.trigger({
            payload: { parent },
            responseMode: "response-only",
          })
          expect(conflict.status).toBe(409)
          expect(yield* conflict.json).toEqual({
            _tag: "ParentInFlight",
            parent,
            scrapeId: row.id,
          })
        }),
    )
    it.effect("POST /scrapes rejects an unknown Listing with 404", () =>
      Effect.gen(function* () {
        yield* reset
        const api = yield* client
        const response = yield* api.scrapes.trigger({
          payload: { parent: { _tag: "Listing", listingId: missingListingId } },
          responseMode: "response-only",
        })
        expect(response.status).toBe(404)
        expect(yield* response.json).toEqual({
          _tag: "ListingNotFound",
          listingId: missingListingId,
        })
      }),
    )
    it.effect(
      "POST /scrapes/bulk answers 202 with created, in-flight and paused counts",
      () =>
        Effect.gen(function* () {
          yield* reset
          const fixture = yield* seed()
          const inFlight = yield* fixture.listing
          yield* fixture.listing
          yield* fixture.page
          const api = yield* client
          yield* api.scrapes.trigger({ payload: { parent: inFlight.parent } })
          const [report, response] = yield* api.scrapes.bulk({
            payload: { _tag: "Brand", brandId: fixture.brandId },
            responseMode: "decoded-and-response",
          })
          expect(response.status).toBe(202)
          expect(report).toEqual({
            created: 2,
            skippedInFlight: 1,
            skippedPaused: 0,
          })
          const paused = yield* seed({ paused: true })
          yield* paused.listing
          yield* paused.page
          expect(
            yield* api.scrapes.bulk({
              payload: { _tag: "Brand", brandId: paused.brandId },
            }),
          ).toEqual({ created: 0, skippedInFlight: 0, skippedPaused: 2 })
        }),
    )
    it.effect(
      "GET /scrapes pages newest first, follows the cursor over a created-at tie and refuses a malformed one",
      () =>
        Effect.gen(function* () {
          // A cursor carries epoch millis, so these rows need a clock past 1970.
          yield* TestClock.setTime(Date.UTC(2026, 8, 9))
          yield* reset
          const fixture = yield* seed()
          const rows = yield* Effect.forEach([1, 2, 3], () =>
            Effect.flatMap(fixture.listing, ({ parent }) =>
              history(parent, "success", "1 hour"),
            ),
          )
          expect(
            new Set(rows.map((row) => DateTime.toEpochMillis(row.createdAt)))
              .size,
          ).toBe(1)
          const expected = [...rows]
            .sort((a, b) => (a.id < b.id ? 1 : -1))
            .map((row) => row.id)
          const api = yield* client
          const first = yield* api.scrapes.list({ query: { limit: 2 } })
          expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 2))
          expect(first.nextCursor).toBe(cursorOf(first.items[1]!))
          const second = yield* api.scrapes.list({
            query: { limit: 2, cursor: first.nextCursor! },
          })
          expect(second.items.map((row) => row.id)).toEqual(expected.slice(2))
          expect(second.nextCursor).toBe(null)
          const raw = yield* ApiTest.rawClient
          for (const query of [
            "cursor=not-a-cursor",
            "cursor=1757376000000:nope",
            "limit=0",
            "limit=101",
          ]) {
            const response = yield* raw.get(
              `${ApiTest.baseUrl}/scrapes?${query}`,
            )
            expect(response.status).toBe(400)
          }
        }),
    )
    it.effect("GET /scrapes filters by Parent and by status", () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const listing = yield* fixture.listing
        const page = yield* fixture.page
        const success = yield* history(listing.parent, "success", "2 hours")
        const failed = yield* history(listing.parent, "failed", "1 hour")
        const pageRow = yield* history(page.parent, "success", "3 hours")
        const api = yield* client
        expect(
          (yield* api.scrapes.list({
            query: { listingId: listing.parent.listingId },
          })).items.map((row) => row.id),
        ).toEqual([failed.id, success.id])
        expect(
          (yield* api.scrapes.list({
            query: { pageId: page.parent.pageId },
          })).items.map((row) => row.id),
        ).toEqual([pageRow.id])
        expect(
          (yield* api.scrapes.list({ query: { status: "failed" } })).items.map(
            (row) => row.id,
          ),
        ).toEqual([failed.id])
      }),
    )
    it.effect(
      "GET /scrapes/:id/content serves the stored HTML and answers 404 once retention took it",
      () =>
        Effect.gen(function* () {
          yield* reset
          const { parent } = yield* (yield* seed()).listing
          const scrape = yield* successfulScrape(parent, {
            html: "<p>Kept</p>",
          })
          const api = yield* client
          const [content, response] = yield* api.scrapes.content({
            params: { id: scrape.id },
            responseMode: "decoded-and-response",
          })
          expect(content).toBe("<p>Kept</p>")
          expect(response.headers["content-type"]).toContain("text/html")
          expect(
            (yield* api.scrapes.get({ params: { id: scrape.id } })).status,
          ).toBe("success")
          yield* (yield* R2BucketTest).service.delete([
            Option.getOrThrow(scrape.htmlR2Key),
          ])
          expect(
            (yield* api.scrapes.content({
              params: { id: scrape.id },
              responseMode: "response-only",
            })).status,
          ).toBe(404)
          expect(
            (yield* api.scrapes.content({
              params: { id: missingScrapeId },
              responseMode: "response-only",
            })).status,
          ).toBe(404)
          expect(
            (yield* api.scrapes.get({
              params: { id: missingScrapeId },
              responseMode: "response-only",
            })).status,
          ).toBe(404)
        }),
    )
    it.effect(
      "POST /extractions answers 202, refuses an in-flight Scrape with 409 and an unextractable one with 422",
      () =>
        Effect.gen(function* () {
          yield* reset
          const { parent } = yield* (yield* seed()).listing
          const scrape = yield* successfulScrape(parent)
          const api = yield* client
          const [row, response] = yield* api.extractions.trigger({
            payload: { _tag: "Scrape", scrapeId: scrape.id },
            responseMode: "decoded-and-response",
          })
          expect(response.status).toBe(202)
          expect(row).toMatchObject({
            scrapeId: scrape.id,
            attempt: 1,
            status: "pending",
            promptKind: "listing",
            promptSnapshot: "Extract listing",
            extractedJson: null,
          })
          const conflict = yield* api.extractions.trigger({
            payload: { _tag: "Scrape", scrapeId: scrape.id },
            responseMode: "response-only",
          })
          expect(conflict.status).toBe(409)
          expect(yield* conflict.json).toEqual({
            _tag: "ExtractionInFlight",
            scrapeId: scrape.id,
            promptKind: "listing",
            extractionId: row.id,
          })
          const failed = yield* history(parent, "failed", "1 hour")
          const unextractable = yield* api.extractions.trigger({
            payload: { _tag: "Scrape", scrapeId: failed.id },
            responseMode: "response-only",
          })
          expect(unextractable.status).toBe(422)
          expect(yield* unextractable.json).toEqual({
            _tag: "ScrapeNotReExtractable",
            scrapeId: failed.id,
            reason: "not_successful",
          })
        }),
    )
    it.effect("POST /extractions/bulk answers 202 with its two counts", () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const first = yield* fixture.listing
        const second = yield* fixture.listing
        yield* successfulScrape(first.parent)
        const already = yield* successfulScrape(second.parent)
        // The current prompt and model already produced this one: nothing to redo.
        yield* extraction(already.id, 1, "success")
        const api = yield* client
        const [report, response] = yield* api.extractions.bulk({
          payload: { retailerId: fixture.retailerId, promptKind: "listing" },
          responseMode: "decoded-and-response",
        })
        expect(response.status).toBe(202)
        expect(report).toEqual({ created: 1, skipped: 1 })
      }),
    )
    it.effect("GET /extractions pages and filters by Scrape and status", () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.UTC(2026, 8, 9))
        yield* reset
        const fixture = yield* seed()
        const { parent } = yield* fixture.listing
        const scrape = yield* successfulScrape(parent)
        const first = yield* extraction(scrape.id, 1, "success", {
          age: "3 hours",
        })
        const second = yield* extraction(scrape.id, 2, "failed", {
          age: "2 hours",
        })
        const third = yield* extraction(scrape.id, 3, "success", {
          age: "1 hour",
        })
        const api = yield* client
        const page = yield* api.extractions.list({ query: { limit: 2 } })
        expect(page.items.map((row) => row.id)).toEqual([third.id, second.id])
        const rest = yield* api.extractions.list({
          query: { cursor: page.nextCursor! },
        })
        expect(rest.items.map((row) => row.id)).toEqual([first.id])
        expect(rest.nextCursor).toBe(null)
        expect(
          (yield* api.extractions.list({
            query: { scrapeId: scrape.id, status: "success" },
          })).items.map((row) => row.id),
        ).toEqual([third.id, first.id])
        const row = yield* api.extractions.get({ params: { id: third.id } })
        expect(row.extractedJson).toEqual({ attempt: 3 })
        expect(row.finishedAt).toEqual(Option.getOrThrow(third.finishedAt))
      }),
    )
    it.effect(
      "latest extracted data keeps the last good answer with its provenance",
      () =>
        Effect.gen(function* () {
          yield* reset
          const fixture = yield* seed()
          const listing = yield* fixture.listing
          const bare = yield* fixture.listing
          const pageParent = (yield* fixture.page).parent
          const good = yield* successfulScrape(listing.parent, {
            age: "2 hours",
          })
          const best = yield* extraction(good.id, 1, "success", {
            age: "100 minutes",
          })
          // A newer Scrape whose Extraction failed must not hide the last good data.
          const newer = yield* successfulScrape(listing.parent, {
            age: "1 hour",
          })
          yield* extraction(newer.id, 1, "failed")
          const pageScrape = yield* successfulScrape(pageParent)
          const pageExtraction = yield* extraction(pageScrape.id, 1, "success")
          const api = yield* client
          const latest = yield* api.extractions.latestForListing({
            params: { id: listing.parent.listingId },
          })
          expect(latest).toEqual({
            parent: listing.parent,
            data: { attempt: 1 },
            provenance: {
              scrapeId: good.id,
              fetchedAt: Option.getOrThrow(good.finishedAt),
              extractionId: best.id,
              extractedAt: Option.getOrThrow(best.finishedAt),
              prompt: best.promptSnapshot,
              model: best.model,
            },
          })
          expect(
            yield* api.extractions.latestForPage({
              params: { id: pageParent.pageId },
            }),
          ).toMatchObject({
            parent: pageParent,
            provenance: { extractionId: pageExtraction.id },
          })
          const product = yield* api.extractions.latestForProduct({
            params: { id: fixture.productId },
          })
          expect(product.items).toEqual([latest])
          for (const response of [
            yield* api.extractions.latestForListing({
              params: { id: bare.parent.listingId },
              responseMode: "response-only",
            }),
            yield* api.extractions.latestForListing({
              params: { id: missingListingId },
              responseMode: "response-only",
            }),
            yield* api.extractions.latestForPage({
              params: { id: missingPageId },
              responseMode: "response-only",
            }),
          ]) {
            expect(response.status).toBe(404)
            expect((yield* response.json) as { _tag: string }).toMatchObject({
              _tag: "NoExtractedData",
            })
          }
          expect(
            yield* api.extractions.latestForProduct({
              params: { id: missingProductId },
            }),
          ).toEqual({ items: [] })
        }),
    )
  },
)

it.layer(ApiTest.layerAnonymous, { timeout: "60 seconds" })(
  "Scraping handlers without a session",
  (it) => {
    it.effect("answer 401 before reaching core", () =>
      Effect.gen(function* () {
        const api = yield* client
        for (const response of [
          yield* api.scrapes.list({ query: {}, responseMode: "response-only" }),
          yield* api.scrapes.trigger({
            payload: {
              parent: { _tag: "Listing", listingId: missingListingId },
            },
            responseMode: "response-only",
          }),
          yield* api.extractions.list({
            query: {},
            responseMode: "response-only",
          }),
        ])
          expect(response.status).toBe(401)
      }),
    )
  },
)
