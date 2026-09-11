import { BulkScrape } from "@digital-shelf/domain/Scraping/ScrapingManagement"
import * as Option from "effect/Option"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import { ScrapesRepo } from "@digital-shelf/core/Scraping/repositories/ScrapesRepo"
import { expect, it } from "@effect/vitest"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { ParentInFlight } from "@digital-shelf/domain/Scraping/Errors"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import { R2BucketTest } from "../layers/R2Bucket.ts"
import {
  reset,
  seed,
  history,
  cadenceFixture,
  successfulScrape,
} from "../fixtures/Scraping.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Scrapes", (it) => {
  it.effect(
    "manual trigger bypasses pause, persists trace context and refuses in-flight parents",
    () =>
      Effect.gen(function* () {
        yield* reset
        const seededCatalog = yield* seed({ paused: true })
        const listing2 = yield* seededCatalog.listing
        const parent = listing2.parent
        const service = yield* Scrapes
        const row = yield* service.trigger({ parent })
        expect(row.status).toBe("pending")
        expect(row.rootSpanId).toMatch(/^[0-9a-f]{16}$/)
        const executionsTest = yield* ExecutionsTest
        const calls = yield* executionsTest.calls
        expect(calls[0]?.instances).toEqual([
          {
            id: row.id,
            traceparent: `00-${row.id.replaceAll("-", "")}-${row.rootSpanId}-01`,
          },
        ])
        expect(yield* Effect.flip(service.trigger({ parent }))).toEqual(
          new ParentInFlight({ parent, scrapeId: row.id }),
        )
      }),
  )
  it.effect(
    "bulk includes listings and pages and reports in-flight skips",
    () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const one = yield* fixture.listing
        yield* fixture.listing
        yield* fixture.page
        const service = yield* Scrapes
        yield* service.trigger({ parent: one.parent })

        const report = yield* service.bulk(
          BulkScrape.members[0].make({
            brandId: fixture.brandId,
          }),
        )

        expect(report.created).toHaveLength(2)
        expect(report.skipped).toEqual([one.parent])
        expect(report.started).toBe(2)
      }),
  )
  it.effect(
    "cadence selection excludes pause, recent success, recent failure and in-flight rows",
    () =>
      Effect.gen(function* () {
        yield* reset
        yield* TestClock.setTime(Date.UTC(2026, 8, 9))
        const fixture = yield* cadenceFixture
        const service = yield* Scrapes

        const report = yield* service.dispatchDue({
          now: yield* DateTime.now,
          limit: 50,
        })

        expect(report.created).toHaveLength(3)

        const rows = yield* Effect.forEach(report.created, (scrapeId) =>
          service.get({ scrapeId }),
        )

        expect(rows.map((row) => row.requestUrl).sort()).toEqual(
          [
            fixture.never.url,
            fixture.oldFailure.url,
            fixture.duePage.url,
          ].sort(),
        )
      }),
  )
  it.effect(
    "drain starts unknown pending executions and skips existing identities",
    () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const service = yield* Scrapes
        yield* service.trigger({ parent: (yield* fixture.listing).parent })
        yield* history((yield* fixture.listing).parent, "pending", "1 hour")
        expect(yield* service.drainPending({ limit: 100 })).toEqual({
          started: 1,
          alreadyActive: 1,
          recoveredFailed: 0,
          unresolved: 0,
        })
        expect(yield* service.drainPending({ limit: 100 })).toEqual({
          started: 0,
          alreadyActive: 2,
          recoveredFailed: 0,
          unresolved: 0,
        })
      }),
  )
  it.effect("bulk starts only 100 and leaves the remainder for drain", () =>
    Effect.gen(function* () {
      yield* reset
      const fixture = yield* seed()

      for (let i = 0; i < 102; i++) yield* fixture.listing
      const service = yield* Scrapes

      const report = yield* service.bulk(
        BulkScrape.members[1].make({
          productId: fixture.productId,
        }),
      )

      expect(report.created).toHaveLength(102)
      expect(report.started).toBe(100)
      expect(yield* service.drainPending({ limit: 102 })).toEqual({
        started: 2,
        alreadyActive: 100,
        recoveredFailed: 0,
        unresolved: 0,
      })
      const executionsTest = yield* ExecutionsTest
      const calls = yield* executionsTest.calls
      expect(calls.every((call) => call.instances.length <= 100)).toBe(true)
    }),
  )
  it.effect(
    "reconciles terminal identities, preserves active rows, and isolates lookup errors",
    () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const executions = yield* ExecutionsTest
        const terminalParent = (yield* fixture.listing).parent
        const terminal = yield* history(terminalParent, "pending", "25 hours")

        const active = yield* history(
          (yield* fixture.listing).parent,
          "pending",
          "25 hours",
        )

        const broken = yield* history(
          (yield* fixture.listing).parent,
          "pending",
          "26 hours",
        )

        const unknown = yield* history(
          (yield* fixture.listing).parent,
          "pending",
          "25 hours",
        )

        yield* executions.setStatus("scrape", terminal.id, "errored")
        yield* executions.setStatus("scrape", active.id, "running")
        yield* executions.setStatus("scrape", broken.id, "errored")
        yield* executions.setStatus("scrape", unknown.id, "unknown")
        yield* executions.failStatus("scrape", broken.id)
        const service = yield* Scrapes
        expect(yield* service.drainPending({ limit: 50 })).toEqual({
          started: 0,
          alreadyActive: 1,
          recoveredFailed: 1,
          unresolved: 2,
        })
        const failed = yield* service.get({ scrapeId: terminal.id })
        expect(failed.status).toBe("failed")
        expect(failed.errorCode).toEqual(Option.some("unknown"))
        expect(failed.finishedAt).toEqual(Option.some(yield* DateTime.now))

        for (const row of [active, broken, unknown])
          expect((yield* service.get({ scrapeId: row.id })).status).toBe(
            "pending",
          )
        expect(
          (yield* service.trigger({ parent: terminalParent })).status,
        ).toBe("pending")
      }),
  )
  it.effect(
    "manual mode and country overrides apply only to advance mode",
    () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const service = yield* Scrapes

        const advanced = yield* service.trigger({
          parent: (yield* fixture.listing).parent,
          mode: "advance",
          country: "Japan",
        })

        expect(advanced.mode).toBe("advance")
        expect(advanced.country).toEqual(Option.some("Japan"))

        const defaultAdvanced = yield* seed({
          mode: "advance",
          country: "Canada",
        })

        const basic = yield* service.trigger({
          parent: (yield* defaultAdvanced.listing).parent,
          mode: "basic",
          country: "Japan",
        })

        expect(basic.mode).toBe("basic")
        expect(basic.country).toEqual(Option.none())

        const countryOnly = yield* service.trigger({
          parent: (yield* defaultAdvanced.listing).parent,
          country: "France",
        })

        expect(countryOnly.mode).toBe("advance")
        expect(countryOnly.country).toEqual(Option.some("France"))
      }),
  )
  it.effect("manual Page trigger classifies its own partial index", () =>
    Effect.gen(function* () {
      yield* reset
      const seededCatalog = yield* seed()
      const page2 = yield* seededCatalog.page
      const parent = page2.parent
      const service = yield* Scrapes
      const row = yield* service.trigger({ parent })
      expect(yield* Effect.flip(service.trigger({ parent }))).toEqual(
        new ParentInFlight({ parent, scrapeId: row.id }),
      )
    }),
  )
  it.effect("disabled tracing fails clearly before creating a row", () =>
    Effect.gen(function* () {
      const scrapesRepo = yield* ScrapesRepo

      yield* reset
      const seededCatalog = yield* seed()
      const listing2 = yield* seededCatalog.listing
      const parent = listing2.parent
      const service = yield* Scrapes

      const exit = yield* service
        .trigger({ parent })
        .pipe(Effect.withTracerEnabled(false), Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)

      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain(
          "Scrape.created needs a real span; tracing is disabled",
        )
      expect(yield* scrapesRepo.listPending(10)).toEqual([])
    }).pipe(Effect.provide([ScrapesRepo.layer])),
  )

  it.effect(
    "bulk counts effectively paused Parents instead of dispatching them",
    () =>
      Effect.gen(function* () {
        const scrapesRepo = yield* ScrapesRepo

        yield* reset
        const fixture = yield* seed({ paused: true })
        const paused = yield* fixture.listing
        const pausedPage = yield* fixture.page
        const service = yield* Scrapes

        const report = yield* service.bulk(
          BulkScrape.members[0].make({
            brandId: fixture.brandId,
          }),
        )

        expect(report.created).toEqual([])
        expect(report.skipped).toEqual([])
        expect(report.skippedPaused).toEqual([paused.parent, pausedPage.parent])
        expect(report.started).toBe(0)
        expect(yield* scrapesRepo.listPending(10)).toEqual([])
      }).pipe(Effect.provide([ScrapesRepo.layer])),
  )
  it.effect("list pages newest first and breaks created-at ties by id", () =>
    Effect.gen(function* () {
      yield* reset
      const fixture = yield* seed()
      const service = yield* Scrapes

      // One clock tick, so all three share a created_at and only id orders them.
      const tied = yield* Effect.forEach([1, 2, 3], () =>
        Effect.flatMap(fixture.listing, ({ parent }) =>
          history(parent, "success", "1 hour"),
        ),
      )

      expect(
        new Set(tied.map((row) => DateTime.toEpochMillis(row.createdAt))).size,
      ).toBe(1)

      const expected = [...tied]
        .sort((a, b) => (a.id < b.id ? 1 : -1))
        .map((row) => row.id)

      const first = yield* service.list({ limit: 2 })
      expect(first.items.map((row) => row.id)).toEqual(expected.slice(0, 2))
      expect(first.hasMore).toBe(true)
      const last = first.items[1]!

      const second = yield* service.list({
        limit: 2,
        cursor: { createdAt: last.createdAt, id: last.id },
      })

      expect(second.items.map((row) => row.id)).toEqual(expected.slice(2))
      expect(second.hasMore).toBe(false)
    }),
  )
  it.effect("list filters by Parent and by status", () =>
    Effect.gen(function* () {
      yield* reset
      const fixture = yield* seed()
      const listing = yield* fixture.listing
      const page = yield* fixture.page
      const service = yield* Scrapes
      const success = yield* history(listing.parent, "success", "2 hours")
      const failed = yield* history(listing.parent, "failed", "1 hour")
      const pageRow = yield* history(page.parent, "success", "3 hours")
      expect(
        (yield* service.list({
          limit: 50,
          listingId: listing.parent.listingId,
        })).items.map((row) => row.id),
      ).toEqual([failed.id, success.id])
      expect(
        (yield* service.list({
          limit: 50,
          pageId: page.parent.pageId,
        })).items.map((row) => row.id),
      ).toEqual([pageRow.id])
      expect(
        (yield* service.list({ limit: 50, status: "failed" })).items.map(
          (row) => row.id,
        ),
      ).toEqual([failed.id])
    }),
  )
  it.effect(
    "content answers the stored HTML and None once retention took it",
    () =>
      Effect.gen(function* () {
        yield* reset
        const seededCatalog = yield* seed()
        const listing2 = yield* seededCatalog.listing
        const parent = listing2.parent
        const service = yield* Scrapes
        const scrape = yield* successfulScrape(parent, { html: "<p>Kept</p>" })
        expect(yield* service.content({ scrapeId: scrape.id })).toEqual(
          Option.some("<p>Kept</p>"),
        )
        // Retention removes the object; the row keeps its key until it expires too.
        const bucketTest = yield* R2BucketTest
        yield* bucketTest.service.delete([Option.getOrThrow(scrape.htmlR2Key)])
        expect(yield* service.content({ scrapeId: scrape.id })).toEqual(
          Option.none(),
        )
        const pending = yield* service.trigger({ parent })
        expect(yield* service.content({ scrapeId: pending.id })).toEqual(
          Option.none(),
        )
      }),
  )
})
