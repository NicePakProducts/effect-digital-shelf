import { ExtractionsErrors, Extractions } from "@app/core/scrapes/extractions"
import { ScrapesErrors } from "@app/core/scrapes"
import { RetailersErrors } from "@app/core/retailers"
import { ProductsErrors } from "@app/core/products"
import * as Result from "effect/Result"
import { Extraction } from "@app/schema/extraction"
import { expect, it } from "@effect/vitest"
import { ExtractionRunner } from "@app/core/scrapes/extractions/runner"
import { ExtractionsRepo } from "../../src/scrapes/extractions/repository"
import { traceparentOf } from "@app/core/scrapes/trace"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { ProductId, ScrapeId, RetailerId } from "@app/schema/ids"
import { RetailersTable } from "@app/db/schema/retailers"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core"
import { ExecutionsTest } from "../layers/Executions"
import {
  reset,
  seed,
  history,
  successfulScrape,
  extraction,
} from "../fixtures/Scraping"

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Extractions", (it) => {
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
            .update(RetailersTable)
            .set({ listingExtractPrompt: "Edited prompt" })
            .where(eq(RetailersTable.id, catalog.retailerId)),
        )
        const service = yield* Extractions.Service

        const row = yield* service.trigger(
          Extraction.Trigger.members[0].make({
            scrapeId: scrape.id,
          }),
        )

        expect(row).toMatchObject({
          attempt: 2,
          promptSnapshot: "Edited prompt",
          model: "@cf/zai-org/glm-4.7-flash",
        })
        const executionsTest = yield* ExecutionsTest
        expect((yield* executionsTest.calls)[0]?.instances).toEqual([
          {
            id: row.id,
            traceparent: traceparentOf(scrape.id, scrape.rootSpanId),
          },
        ])
        expect(
          yield* Effect.flip(
            service.trigger(
              Extraction.Trigger.members[0].make({ scrapeId: scrape.id }),
            ),
          ),
        ).toEqual(
          new ExtractionsErrors.InFlight({
            scrapeId: scrape.id,
            promptKind: "listing",
            extractionId: row.id,
          }),
        )
        const extractionRunner = yield* ExtractionRunner.Service
        yield* extractionRunner.fail(row.id, "unknown", "test")
        expect(
          (yield* service.trigger(
            Extraction.Trigger.members[0].make({ scrapeId: scrape.id }),
          )).attempt,
        ).toBe(3)
      }),
  )
  it.effect(
    "single never skips matching success and eight concurrent triggers create exactly one attempt",
    () =>
      Effect.gen(function* () {
        yield* reset

        const seededCatalog = yield* seed()

        const scrape = yield* successfulScrape(
          (yield* seededCatalog.listing).parent,
        )

        yield* extraction(scrape.id, 1, "success")
        const service = yield* Extractions.Service

        const results = yield* Effect.all(
          Array.from({ length: 8 }, () =>
            service
              .trigger(
                Extraction.Trigger.members[0].make({ scrapeId: scrape.id }),
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
          expect(result.failure).toBeInstanceOf(ExtractionsErrors.InFlight)
        expect(
          yield* service.listByScrape({ scrapeId: scrape.id }),
        ).toHaveLength(2)
      }),
  )
  it.effect("rejects unsuccessful, expired and missing Scrapes", () =>
    Effect.gen(function* () {
      yield* reset
      const seededCatalog = yield* seed()
      const parent = (yield* seededCatalog.listing).parent
      const failed = yield* history(parent, "failed", "1 hour")
      const expired = yield* successfulScrape(parent)
      const db = yield* Db
      yield* query(
        db
          .update(ScrapesTable)
          .set({ htmlR2Key: null })
          .where(eq(ScrapesTable.id, expired.id)),
      )
      const service = yield* Extractions.Service

      for (const [row, reason] of [
        [failed, "not_successful"],
        [expired, "html_expired"],
      ] as const)
        expect(
          yield* Effect.flip(
            service.trigger(
              Extraction.Trigger.members[0].make({ scrapeId: row.id }),
            ),
          ),
        ).toEqual(
          new ExtractionsErrors.ScrapeNotReExtractable({
            scrapeId: row.id,
            reason,
          }),
        )
      const id = Schema.decodeUnknownSync(ScrapeId)(crypto.randomUUID())
      expect(
        yield* Effect.flip(
          service.trigger(Extraction.Trigger.members[0].make({ scrapeId: id })),
        ),
      ).toEqual(new ScrapesErrors.NotFound({ scrapeId: id }))
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
        const service = yield* Extractions.Service

        const row = yield* service.trigger(
          Extraction.Trigger.members[1].make({ parent }),
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
              Extraction.Trigger.members[1].make({ parent: empty }),
            ),
          ),
        ).toEqual(new ExtractionsErrors.NoSuccessfulScrape({ parent: empty }))
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
        const service = yield* Extractions.Service

        const report = yield* service.bulk({
          retailerId: catalog.retailerId,
          promptKind: "listing",
        })

        expect(report).toMatchObject({ skipped: 2, started: 1 })
        expect(report.created).toHaveLength(1)
        expect(
          (yield* service.get({ extractionId: report.created[0]! })).scrapeId,
        ).toBe(b.id)
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
        const service = yield* Extractions.Service

        const report = yield* service.bulk({
          retailerId: catalog.retailerId,
          promptKind: "listing",
        })

        expect(report.created).toHaveLength(150)
        expect(report.started).toBe(100)
        const runner = yield* ExtractionRunner.Service

        for (const id of report.created.slice(0, 100)) yield* runner.claim(id)
        expect(yield* service.drainPending({ limit: 100 })).toEqual({
          started: 50,
          alreadyActive: 0,
          recoveredFailed: 0,
          unresolved: 0,
        })
        const executionsTest = yield* ExecutionsTest
        const calls = yield* executionsTest.calls
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

      const extractions = yield* Extractions.Service
      expect(
        yield* Effect.flip(
          extractions.bulk({ retailerId, promptKind: "listing" }),
        ),
      ).toEqual(new RetailersErrors.NotFound({ retailerId }))
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
        const service = yield* Extractions.Service
        expect(yield* service.drainPending({ limit: 100 })).toEqual({
          started: 0,
          recoveredFailed: 1,
          alreadyActive: 1,
          unresolved: 2,
        })
        expect(yield* service.get({ extractionId: rows[0]!.id })).toMatchObject(
          {
            status: "failed",
            errorCode: Option.some("unknown"),
          },
        )

        for (const row of rows.slice(1))
          expect((yield* service.get({ extractionId: row.id })).status).toBe(
            "pending",
          )
      }),
  )
  it.effect("redispatch starts pending rows and refuses running rows", () =>
    Effect.gen(function* () {
      yield* reset

      const catalog = yield* seed()
      const listing = yield* catalog.listing
      const scrape = yield* successfulScrape(listing.parent)
      const row = yield* extraction(scrape.id, 1, "pending")

      const service = yield* Extractions.Service
      expect(yield* service.redispatch({ extractionId: row.id })).toBe(
        "created",
      )
      expect(yield* service.redispatch({ extractionId: row.id })).toBe(
        "already-active",
      )
      const extractionRunner = yield* ExtractionRunner.Service
      yield* extractionRunner.claim(row.id)
      expect(
        yield* Effect.flip(service.redispatch({ extractionId: row.id })),
      ).toMatchObject({
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
        const extractionsRepo = yield* ExtractionsRepo.Service

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
        const service = yield* Extractions.Service

        const data = Option.getOrThrow(
          yield* service.latestExtractedData({ parent: first }),
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
        expect(yield* service.latestExtractedData({ parent: empty })).toEqual(
          Option.none(),
        )

        const result = yield* service.latestExtractedDataForProduct({
          productId: catalog.productId,
        })

        expect(result.map((item) => item.parent)).toEqual([first, second])
        expect(
          result.find((item) => item.provenance.scrapeId === older.id),
        ).toEqual(data)
        expect(
          Option.getOrThrow(yield* extractionsRepo.latestSuccessful(older.id))
            .id,
        ).toBe(best.id)
        const seededCatalog = yield* seed()
        expect(
          yield* service.latestExtractedDataForProduct({
            productId: seededCatalog.productId,
          }),
        ).toEqual([])
        const unknown = Schema.decodeUnknownSync(ProductId)(crypto.randomUUID())
        expect(
          yield* Effect.flip(
            service.latestExtractedDataForProduct({ productId: unknown }),
          ),
        ).toEqual(new ProductsErrors.NotFound({ productId: unknown }))
      }).pipe(Effect.provide([ExtractionsRepo.layer])),
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
        const db = yield* Db
        yield* query(
          db
            .update(ScrapesTable)
            .set({ htmlR2Key: null })
            .where(eq(ScrapesTable.id, newest.id)),
        )
        const service = yield* Extractions.Service
        expect(
          yield* Effect.flip(
            service.trigger(Extraction.Trigger.members[1].make({ parent })),
          ),
        ).toEqual(
          new ExtractionsErrors.ScrapeNotReExtractable({
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
        expect(yield* service.listByScrape({ scrapeId: older.id })).toEqual([])
        expect(yield* service.listByScrape({ scrapeId: newest.id })).toEqual([])
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
      const service = yield* Extractions.Service
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
