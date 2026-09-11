import * as Result from "effect/Result"
import { TriggerExtraction } from "@digital-shelf/domain/Scraping/ScrapingManagement"
import { expect, it } from "@effect/vitest"
import { Extractions } from "@digital-shelf/core/Scraping/Extractions"
import { ExtractionRunner } from "@digital-shelf/core/Scraping/ExtractionRunner"
import * as Repo from "@digital-shelf/core/Scraping/repositories/ExtractionsRepo"
import { traceparentOf } from "@digital-shelf/core/Scraping/Trace"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import {
  ExtractionInFlight,
  NoSuccessfulScrape,
  ScrapeNotFound,
  ScrapeNotReExtractable,
} from "@digital-shelf/domain/Scraping/Errors"
import {
  ProductNotFound,
  RetailerNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import {
  ProductId,
  ScrapeId,
  RetailerId,
} from "@digital-shelf/domain/Shared/Ids"
import { retailers } from "@digital-shelf/domain/Sql/Catalog"
import { scrapes } from "@digital-shelf/domain/Sql/Scraping"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import {
  reset,
  seed,
  history,
  successfulScrape,
  extraction,
} from "../fixtures/Scraping.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Extractions", (it) => {
  it.effect(
    "manual creation snapshots current prompt, allocates monotonically and carries trace identity",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed()
        const scrape = yield* successfulScrape((yield* catalog.listing).parent)
        yield* extraction(scrape.id, 1, "success")
        const db = yield* Db
        yield* query(
          db
            .update(retailers)
            .set({ listingExtractPrompt: "Edited prompt" })
            .where(eq(retailers.id, catalog.retailerId)),
        )
        const service = yield* Extractions

        const row = yield* service.trigger(
          TriggerExtraction.members[0].make({
            scrapeId: scrape.id,
          }),
        )

        expect(row).toMatchObject({
          attempt: 2,
          promptSnapshot: "Edited prompt",
          model: "@cf/zai-org/glm-4.7-flash",
        })
        expect((yield* (yield* ExecutionsTest).calls)[0]?.instances).toEqual([
          {
            id: row.id,
            traceparent: traceparentOf(scrape.id, scrape.rootSpanId),
          },
        ])
        expect(
          yield* Effect.flip(
            service.trigger(
              TriggerExtraction.members[0].make({ scrapeId: scrape.id }),
            ),
          ),
        ).toEqual(
          new ExtractionInFlight({
            scrapeId: scrape.id,
            promptKind: "listing",
            extractionId: row.id,
          }),
        )
        yield* (yield* ExtractionRunner).fail(row.id, "unknown", "test")
        expect(
          (yield* service.trigger(
            TriggerExtraction.members[0].make({ scrapeId: scrape.id }),
          )).attempt,
        ).toBe(3)
      }),
  )
  it.effect(
    "single never skips matching success and eight concurrent triggers create exactly one attempt",
    () =>
      Effect.gen(function* () {
        yield* reset

        const scrape = yield* successfulScrape(
          (yield* (yield* seed()).listing).parent,
        )

        yield* extraction(scrape.id, 1, "success")
        const service = yield* Extractions

        const results = yield* Effect.all(
          Array.from({ length: 8 }, () =>
            service
              .trigger(
                TriggerExtraction.members[0].make({ scrapeId: scrape.id }),
              )
              .pipe(Effect.result),
          ),
          { concurrency: "unbounded" },
        )

        const successes = results.filter((result) => Result.isSuccess(result))
        expect(successes).toHaveLength(1)
        expect(successes[0]?.success.attempt).toBe(2)
        const failures = results.filter((result) => Result.isFailure(result))
        expect(failures).toHaveLength(7)

        for (const result of failures)
          expect(result.failure).toBeInstanceOf(ExtractionInFlight)
        expect(yield* service.listByScrape(scrape.id)).toHaveLength(2)
      }),
  )
  it.effect("rejects unsuccessful, expired and missing Scrapes", () =>
    Effect.gen(function* () {
      yield* reset
      const parent = (yield* (yield* seed()).listing).parent
      const failed = yield* history(parent, "failed", "1 hour")
      const expired = yield* successfulScrape(parent)
      yield* query(
        (yield* Db)
          .update(scrapes)
          .set({ htmlR2Key: null })
          .where(eq(scrapes.id, expired.id)),
      )
      const service = yield* Extractions

      for (const [row, reason] of [
        [failed, "not_successful"],
        [expired, "html_expired"],
      ] as const)
        expect(
          yield* Effect.flip(
            service.trigger(
              TriggerExtraction.members[0].make({ scrapeId: row.id }),
            ),
          ),
        ).toEqual(new ScrapeNotReExtractable({ scrapeId: row.id, reason }))
      const id = Schema.decodeUnknownSync(ScrapeId)(crypto.randomUUID())
      expect(
        yield* Effect.flip(
          service.trigger(TriggerExtraction.members[0].make({ scrapeId: id })),
        ),
      ).toEqual(new ScrapeNotFound({ scrapeId: id }))
    }),
  )
  it.effect(
    "Parent trigger chooses newest stored success and distinguishes missing success",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed()
        const parent = (yield* catalog.page).parent
        yield* successfulScrape(parent, { age: "2 hours" })
        const newest = yield* successfulScrape(parent, { age: "1 hour" })
        const service = yield* Extractions

        const row = yield* service.trigger(
          TriggerExtraction.members[1].make({ parent }),
        )

        expect(row).toMatchObject({
          scrapeId: newest.id,
          promptKind: "page",
          promptSnapshot: "Extract page",
        })
        const empty = (yield* catalog.listing).parent
        yield* history(empty, "failed", "1 hour")
        expect(
          yield* Effect.flip(
            service.trigger(
              TriggerExtraction.members[1].make({ parent: empty }),
            ),
          ),
        ).toEqual(new NoSuccessfulScrape({ parent: empty }))
      }),
  )
  it.effect(
    "bulk skips matching and in-flight, ignores pause and considers only the newest success of the requested kind",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed({ paused: true })
        const a = (yield* catalog.listing).parent
        const old = yield* successfulScrape(a, { age: "2 hours" })
        yield* extraction(old.id, 1, "success", { prompt: "Old" })
        const current = yield* successfulScrape(a, { age: "1 hour" })
        yield* extraction(current.id, 1, "success")
        const b = yield* successfulScrape((yield* catalog.listing).parent)
        yield* extraction(b.id, 1, "success", { prompt: "Old" })
        const c = yield* successfulScrape((yield* catalog.listing).parent)
        yield* extraction(c.id, 1, "pending")
        yield* successfulScrape((yield* catalog.page).parent)
        const service = yield* Extractions

        const report = yield* service.bulk({
          retailerId: catalog.retailerId,
          promptKind: "listing",
        })

        expect(report).toMatchObject({ skipped: 2, started: 1 })
        expect(report.created).toHaveLength(1)
        expect((yield* service.get(report.created[0]!)).scrapeId).toBe(b.id)
      }),
  )
  it.effect(
    "bulk starts 100 of 150, then drain starts the remaining 50 after claims",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed()

        for (let i = 0; i < 150; i++)
          yield* successfulScrape((yield* catalog.listing).parent)
        const service = yield* Extractions

        const report = yield* service.bulk({
          retailerId: catalog.retailerId,
          promptKind: "listing",
        })

        expect(report.created).toHaveLength(150)
        expect(report.started).toBe(100)
        const runner = yield* ExtractionRunner

        for (const id of report.created.slice(0, 100)) yield* runner.claim(id)
        expect(yield* service.drainPending(100)).toEqual({
          started: 50,
          alreadyActive: 0,
          recoveredFailed: 0,
          unresolved: 0,
        })
        const calls = yield* (yield* ExecutionsTest).calls
        expect(
          calls
            .filter((call) => call.operation === "start")
            .every((call) => call.instances.length <= 100),
        ).toBe(true)
      }),
    // 150 inserts plus 100 claims exceed vitest's 5 s default when every
    // PGlite file boots in parallel.
    60_000,
  )
  it.effect("unknown retailer is a domain error", () =>
    Effect.gen(function* () {
      yield* reset

      const retailerId = Schema.decodeUnknownSync(RetailerId)(
        crypto.randomUUID(),
      )

      expect(
        yield* Effect.flip(
          (yield* Extractions).bulk({ retailerId, promptKind: "listing" }),
        ),
      ).toEqual(new RetailerNotFound({ retailerId }))
    }),
  )
  it.effect(
    "drain reconciles terminal, active and unknown executions and isolates status failures",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed()
        const rows = []

        for (let i = 0; i < 4; i++)
          rows.push(
            yield* extraction(
              (yield* successfulScrape((yield* catalog.listing).parent)).id,
              1,
              "pending",
            ),
          )
        const fake = yield* ExecutionsTest

        for (const [i, status] of [
          "complete",
          "running",
          "unknown",
          "complete",
        ].entries())
          yield* fake.setStatus(
            "extraction",
            rows[i]!.id,
            Schema.decodeUnknownSync(
              Schema.Literals(["complete", "running", "unknown"]),
            )(status),
          )
        yield* fake.failStatus("extraction", rows[3]!.id)
        const service = yield* Extractions
        expect(yield* service.drainPending(100)).toEqual({
          started: 0,
          recoveredFailed: 1,
          alreadyActive: 1,
          unresolved: 2,
        })
        expect(yield* service.get(rows[0]!.id)).toMatchObject({
          status: "failed",
          errorCode: Option.some("unknown"),
        })

        for (const row of rows.slice(1))
          expect((yield* service.get(row.id)).status).toBe("pending")
      }),
  )
  it.effect("redispatch starts pending rows and refuses running rows", () =>
    Effect.gen(function* () {
      yield* reset

      const row = yield* extraction(
        (yield* successfulScrape((yield* (yield* seed()).listing).parent)).id,
        1,
        "pending",
      )

      const service = yield* Extractions
      expect(yield* service.redispatch(row.id)).toBe("created")
      expect(yield* service.redispatch(row.id)).toBe("already-active")
      yield* (yield* ExtractionRunner).claim(row.id)
      expect(yield* Effect.flip(service.redispatch(row.id))).toMatchObject({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
        _tag: "TransitionRejected",
        kind: "extraction",
        observed: "running",
      })
    }),
  )
  it.effect(
    "latest data falls back to last good Scrape and highest successful attempt with ordered per-Listing provenance",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed()
        const first = (yield* catalog.listing).parent
        yield* TestClock.adjust("1 second")
        const second = (yield* catalog.listing).parent
        const empty = (yield* catalog.listing).parent
        const older = yield* successfulScrape(first, { age: "2 hours" })
        yield* extraction(older.id, 1, "success", { age: "90 minutes" })

        const best = yield* extraction(older.id, 2, "success", {
          age: "80 minutes",
        })

        yield* extraction(older.id, 3, "failed")
        const newer = yield* successfulScrape(first, { age: "1 hour" })
        yield* extraction(newer.id, 1, "failed")
        yield* extraction((yield* successfulScrape(second)).id, 1, "success")
        const service = yield* Extractions

        const data = Option.getOrThrow(
          yield* service.latestExtractedData(first),
        )

        expect(data).toEqual({
          parent: first,
          data: { attempt: 2 },
          provenance: {
            scrapeId: older.id,
            fetchedAt: Option.getOrThrow(older.finishedAt),
            extractionId: best.id,
            extractedAt: Option.getOrThrow(best.finishedAt),
            prompt: best.promptSnapshot,
            model: best.model,
          },
        })
        expect(yield* service.latestExtractedData(empty)).toEqual(Option.none())

        const result = yield* service.latestExtractedDataForProduct(
          catalog.productId,
        )

        expect(result.map((item) => item.parent)).toEqual([first, second])
        expect(
          result.find((item) => item.provenance.scrapeId === older.id),
        ).toEqual(data)
        expect(
          Option.getOrThrow(yield* Repo.latestSuccessful(older.id)).id,
        ).toBe(best.id)
        expect(
          yield* service.latestExtractedDataForProduct(
            (yield* seed()).productId,
          ),
        ).toEqual([])
        const unknown = Schema.decodeUnknownSync(ProductId)(crypto.randomUUID())
        expect(
          yield* Effect.flip(service.latestExtractedDataForProduct(unknown)),
        ).toEqual(new ProductNotFound({ productId: unknown }))
      }),
  )
  it.effect(
    "newest successful Scrape with expired HTML is not replaced by older retained HTML",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed()
        const parent = (yield* catalog.listing).parent
        const older = yield* successfulScrape(parent, { age: "2 hours" })
        const newest = yield* successfulScrape(parent, { age: "1 hour" })
        yield* query(
          (yield* Db)
            .update(scrapes)
            .set({ htmlR2Key: null })
            .where(eq(scrapes.id, newest.id)),
        )
        const service = yield* Extractions
        expect(
          yield* Effect.flip(
            service.trigger(TriggerExtraction.members[1].make({ parent })),
          ),
        ).toEqual(
          new ScrapeNotReExtractable({
            scrapeId: newest.id,
            reason: "html_expired",
          }),
        )
        expect(
          yield* service.bulk({
            retailerId: catalog.retailerId,
            promptKind: "listing",
          }),
        ).toEqual({ created: [], skipped: 1, started: 0 })
        expect(yield* service.listByScrape(older.id)).toEqual([])
        expect(yield* service.listByScrape(newest.id)).toEqual([])
      }),
  )

  it.effect("list pages newest first, filtered by Scrape and by status", () =>
    Effect.gen(function* () {
      yield* reset
      const catalog = yield* seed()
      const parent = (yield* catalog.listing).parent
      const other = (yield* catalog.listing).parent
      const scrape = yield* successfulScrape(parent)
      const otherScrape = yield* successfulScrape(other)

      const first = yield* extraction(scrape.id, 1, "success", {
        age: "3 hours",
      })

      const second = yield* extraction(scrape.id, 2, "failed", {
        age: "2 hours",
      })

      const third = yield* extraction(scrape.id, 3, "success", {
        age: "1 hour",
      })

      const elsewhere = yield* extraction(otherScrape.id, 1, "success")
      const service = yield* Extractions
      const page = yield* service.list({ limit: 2 })
      expect(page.items.map((row) => row.id)).toEqual([elsewhere.id, third.id])
      expect(page.hasMore).toBe(true)
      const last = page.items[1]!

      const rest = yield* service.list({
        limit: 2,
        cursor: { createdAt: last.createdAt, id: last.id },
      })

      expect(rest.items.map((row) => row.id)).toEqual([second.id, first.id])
      expect(rest.hasMore).toBe(false)
      expect(
        (yield* service.list({ limit: 50, scrapeId: scrape.id })).items.map(
          (row) => row.id,
        ),
      ).toEqual([third.id, second.id, first.id])
      expect(
        (yield* service.list({
          limit: 50,
          scrapeId: scrape.id,
          status: "success",
        })).items.map((row) => row.id),
      ).toEqual([third.id, first.id])
    }),
  )
})
