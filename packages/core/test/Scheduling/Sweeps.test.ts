import { ExtractionsRepo } from "@digital-shelf/core/Scraping/repositories/ExtractionsRepo"
import { successfulScrape, extraction } from "../fixtures/Scraping.ts"
import { expect, it } from "@effect/vitest"
import { Sweeps } from "@digital-shelf/core/Scheduling/Sweeps"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { R2Bucket } from "@digital-shelf/core/Storage/R2Bucket"
import { ScrapesRepo } from "@digital-shelf/core/Scraping/repositories/ScrapesRepo"
import * as Array from "effect/Array"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import { R2BucketTest } from "../layers/R2Bucket.ts"
import { reset, seed, history } from "../fixtures/Scraping.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Sweeps", (it) => {
  it.effect(
    "stuck fails every overdue running row, terminates executions and removes objects",
    () =>
      Effect.gen(function* () {
        yield* reset
        yield* TestClock.setTime(Date.UTC(2026, 8, 9))
        const fixture = yield* seed()

        const terminal = yield* history(
          (yield* fixture.listing).parent,
          "running",
          "7 minutes",
          "6 minutes",
        )

        const active = yield* history(
          (yield* fixture.listing).parent,
          "running",
          "7 minutes",
          "6 minutes",
        )

        const recent = yield* history(
          (yield* fixture.listing).parent,
          "running",
          "2 minutes",
          "1 minute",
        )

        const missing = yield* history(
          (yield* fixture.listing).parent,
          "running",
          "7 minutes",
          "6 minutes",
        )

        const unknown = yield* history(
          (yield* fixture.listing).parent,
          "running",
          "7 minutes",
          "6 minutes",
        )

        const executions = yield* ExecutionsTest
        yield* executions.setStatus("scrape", terminal.id, "errored")
        yield* executions.setStatus("scrape", active.id, "running")
        yield* executions.setStatus("scrape", unknown.id, "unknown")
        const bucket = yield* R2Bucket

        for (const row of [terminal, active, missing, unknown]) {
          yield* bucket.put(`html/${row.id}.html`, "html", "text/html")
          yield* bucket.put(`raw/${row.id}.json`, "{}", "application/json")
        }

        const sweeps = yield* Sweeps
        expect(yield* sweeps.stuck({ now: yield* DateTime.now })).toEqual({
          examined: 4,
          failed: 4,
          alreadyTerminal: 0,
          extractionsExamined: 0,
          extractionsFailed: 0,
          extractionsAlreadyTerminal: 0,
        })
        const scrapes = yield* Scrapes

        for (const row of [recent])
          expect((yield* scrapes.get({ scrapeId: row.id })).status).toBe(
            "running",
          )

        for (const row of [terminal, active, missing, unknown])
          expect((yield* scrapes.get({ scrapeId: row.id })).errorCode).toEqual(
            Option.some("timeout"),
          )

        for (const row of [terminal, active, missing, unknown])
          expect(
            yield* executions.service.status({ kind: "scrape", id: row.id }),
          ).toEqual(Option.some("terminated"))
        const bucketTest = yield* R2BucketTest
        expect((yield* bucketTest.inspect).size).toBe(0)
      }),
  )
  it.effect(
    "retention deletes oldest terminal rows up to its cap, objects after rows, and reports backlog",
    () =>
      Effect.gen(function* () {
        const scrapesRepo = yield* ScrapesRepo

        yield* reset
        yield* TestClock.setTime(Date.UTC(2026, 8, 9))
        const fixture = yield* seed()
        const parent = (yield* fixture.listing).parent
        const bucket = yield* R2Bucket

        for (const i of Array.range(0, 51)) {
          const row = yield* history(parent, "success", `${100 + i} days`)
          yield* bucket.put(`html/${row.id}.html`, "html", "text/html")
          yield* bucket.put(`raw/${row.id}.json`, "{}", "application/json")
        }

        const pending = yield* history(parent, "pending", "200 days")
        const sweeps = yield* Sweeps
        const report = yield* sweeps.retention({ now: yield* DateTime.now })
        expect(report.deleted).toBe(50)
        expect(report.remaining).toBe(2)
        expect(report.oldestCreatedAt).toBe(
          DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, "101 days"),
          ),
        )
        const bucketTest = yield* R2BucketTest
        expect((yield* bucketTest.inspect).size).toBe(4)
        expect(Option.isSome(yield* scrapesRepo.find(pending.id))).toBe(true)
        expect(yield* sweeps.retention({ now: yield* DateTime.now })).toEqual({
          deleted: 2,
          remaining: 0,
          oldestCreatedAt: null,
        })
      }).pipe(Effect.provide([ScrapesRepo.layer])),
  )
  it.effect(
    "object deletion failures leave rows deleted and are swallowed",
    () =>
      Effect.gen(function* () {
        const scrapesRepo = yield* ScrapesRepo

        yield* reset
        const seededCatalog = yield* seed()
        const parent = (yield* seededCatalog.listing).parent
        const row = yield* history(parent, "failed", "100 days")
        const bucket = yield* R2Bucket
        yield* bucket.put(`html/${row.id}.html`, "html", "text/html")
        const bucketTest = yield* R2BucketTest
        yield* bucketTest.failNextDelete
        const sweeps = yield* Sweeps
        expect(yield* sweeps.retention({ now: yield* DateTime.now })).toEqual({
          deleted: 1,
          remaining: 0,
          oldestCreatedAt: null,
        })
        expect(Option.isNone(yield* scrapesRepo.find(row.id))).toBe(true)
        expect((yield* bucketTest.inspect).size).toBe(1)
      }).pipe(Effect.provide([ScrapesRepo.layer])),
  )
  it.effect(
    "termination and storage failures do not undo failure or stop the remaining rows",
    () =>
      Effect.gen(function* () {
        const scrapesRepo = yield* ScrapesRepo

        yield* reset
        const fixture = yield* seed()

        const rows = yield* Effect.forEach(Array.range(0, 2), () =>
          Effect.gen(function* () {
            return yield* history(
              (yield* fixture.listing).parent,
              "running",
              "7 minutes",
              "6 minutes",
            )
          }),
        )

        const executions = yield* ExecutionsTest

        for (const row of rows) {
          yield* executions.setStatus("scrape", row.id, "running")
          const bucket = yield* R2Bucket
          yield* bucket.put(`html/${row.id}.html`, "html", "text/html")
        }

        yield* executions.failTerminate("scrape", rows[0]!.id)
        const bucketTest = yield* R2BucketTest
        yield* bucketTest.failNextDelete
        const sweeps = yield* Sweeps
        expect(yield* sweeps.stuck({ now: yield* DateTime.now })).toEqual({
          examined: 3,
          failed: 3,
          alreadyTerminal: 0,
          extractionsExamined: 0,
          extractionsFailed: 0,
          extractionsAlreadyTerminal: 0,
        })

        for (const row of rows)
          expect((yield* scrapesRepo.get(row.id)).status).toBe("failed")
        expect(
          yield* executions.service.status({ kind: "scrape", id: rows[0]!.id }),
        ).toEqual(Option.some("running"))
        expect((yield* bucketTest.inspect).size).toBe(1)
      }).pipe(Effect.provide([ScrapesRepo.layer])),
  )
  it.effect(
    "one stuck sweep covers Scrapes and Extractions without deleting Extraction HTML",
    () =>
      Effect.gen(function* () {
        const extractionsRepo = yield* ExtractionsRepo

        yield* reset
        const catalog = yield* seed()
        const scrape = yield* successfulScrape((yield* catalog.listing).parent)

        const overdue = yield* extraction(scrape.id, 1, "running", {
          age: "6 minutes",
        })

        const recent = yield* extraction(
          (yield* successfulScrape((yield* catalog.listing).parent)).id,
          1,
          "running",
          { age: "4 minutes" },
        )

        yield* history(
          (yield* catalog.listing).parent,
          "running",
          "7 minutes",
          "6 minutes",
        )
        const sweeps = yield* Sweeps
        const report = yield* sweeps.stuck({ now: yield* DateTime.now })
        expect(report).toEqual({
          examined: 1,
          failed: 1,
          alreadyTerminal: 0,
          extractionsExamined: 1,
          extractionsFailed: 1,
          extractionsAlreadyTerminal: 0,
        })
        expect(yield* extractionsRepo.get(overdue.id)).toMatchObject({
          status: "failed",
          errorCode: Option.some("llm_timeout"),
          errorMessage: Option.some("Extraction exceeded the stuck bound"),
        })
        expect((yield* extractionsRepo.get(recent.id)).status).toBe("running")
        const executionsTest = yield* ExecutionsTest
        expect(
          yield* executionsTest.service.status({
            kind: "extraction",
            id: overdue.id,
          }),
        ).toEqual(Option.some("terminated"))
        const bucketTest = yield* R2BucketTest
        expect(
          (yield* bucketTest.inspect).has(Option.getOrThrow(scrape.htmlR2Key)),
        ).toBe(true)
      }).pipe(Effect.provide([ExtractionsRepo.layer])),
  )
})
