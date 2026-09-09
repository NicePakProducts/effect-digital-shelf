import { expect, it } from "@effect/vitest"
import { Sweeps } from "@digital-shelf/core/Scheduling/Sweeps"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { R2Bucket } from "@digital-shelf/core/Storage/R2Bucket"
import * as ScrapesRepo from "@digital-shelf/core/Scraping/repositories/ScrapesRepo"
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
        expect(yield* sweeps.stuck(yield* DateTime.now)).toEqual({
          examined: 4,
          failed: 4,
          alreadyTerminal: 0,
        })
        const scrapes = yield* Scrapes
        for (const row of [recent])
          expect((yield* scrapes.get(row.id)).status).toBe("running")
        for (const row of [terminal, active, missing, unknown])
          expect((yield* scrapes.get(row.id)).errorCode).toEqual(
            Option.some("timeout"),
          )
        for (const row of [terminal, active, missing, unknown])
          expect(yield* executions.service.status("scrape", row.id)).toEqual(
            Option.some("terminated"),
          )
        expect((yield* (yield* R2BucketTest).inspect).size).toBe(0)
      }),
  )
  it.effect(
    "retention deletes oldest terminal rows up to its cap, objects after rows, and reports backlog",
    () =>
      Effect.gen(function* () {
        yield* reset
        yield* TestClock.setTime(Date.UTC(2026, 8, 9))
        const fixture = yield* seed()
        const parent = (yield* fixture.listing).parent
        const bucket = yield* R2Bucket
        for (let i = 0; i < 52; i++) {
          const row = yield* history(parent, "success", `${100 + i} days`)
          yield* bucket.put(`html/${row.id}.html`, "html", "text/html")
          yield* bucket.put(`raw/${row.id}.json`, "{}", "application/json")
        }
        const pending = yield* history(parent, "pending", "200 days")
        const sweeps = yield* Sweeps
        const report = yield* sweeps.retention(yield* DateTime.now)
        expect(report.deleted).toBe(50)
        expect(report.remaining).toBe(2)
        expect(report.oldestCreatedAt).toBe(
          DateTime.formatIso(
            DateTime.subtractDuration(yield* DateTime.now, "101 days"),
          ),
        )
        expect((yield* (yield* R2BucketTest).inspect).size).toBe(4)
        expect(Option.isSome(yield* ScrapesRepo.find(pending.id))).toBe(true)
        expect(yield* sweeps.retention(yield* DateTime.now)).toEqual({
          deleted: 2,
          remaining: 0,
          oldestCreatedAt: null,
        })
      }),
  )
  it.effect(
    "object deletion failures leave rows deleted and are swallowed",
    () =>
      Effect.gen(function* () {
        yield* reset
        const parent = (yield* (yield* seed()).listing).parent
        const row = yield* history(parent, "failed", "100 days")
        yield* (yield* R2Bucket).put(`html/${row.id}.html`, "html", "text/html")
        yield* (yield* R2BucketTest).failNextDelete
        expect(yield* (yield* Sweeps).retention(yield* DateTime.now)).toEqual({
          deleted: 1,
          remaining: 0,
          oldestCreatedAt: null,
        })
        expect(Option.isNone(yield* ScrapesRepo.find(row.id))).toBe(true)
        expect((yield* (yield* R2BucketTest).inspect).size).toBe(1)
      }),
  )
  it.effect(
    "termination and storage failures do not undo failure or stop the remaining rows",
    () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const rows = []
        for (let i = 0; i < 3; i++)
          rows.push(
            yield* history(
              (yield* fixture.listing).parent,
              "running",
              "7 minutes",
              "6 minutes",
            ),
          )
        const executions = yield* ExecutionsTest
        for (const row of rows) {
          yield* executions.setStatus("scrape", row.id, "running")
          yield* (yield* R2Bucket).put(
            `html/${row.id}.html`,
            "html",
            "text/html",
          )
        }
        yield* executions.failTerminate("scrape", rows[0]!.id)
        yield* (yield* R2BucketTest).failNextDelete
        expect(yield* (yield* Sweeps).stuck(yield* DateTime.now)).toEqual({
          examined: 3,
          failed: 3,
          alreadyTerminal: 0,
        })
        for (const row of rows)
          expect((yield* ScrapesRepo.get(row.id)).status).toBe("failed")
        expect(yield* executions.service.status("scrape", rows[0]!.id)).toEqual(
          Option.some("running"),
        )
        expect((yield* (yield* R2BucketTest).inspect).size).toBe(1)
      }),
  )
})
