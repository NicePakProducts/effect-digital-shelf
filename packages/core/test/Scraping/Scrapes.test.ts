import * as Option from "effect/Option"
import * as Exit from "effect/Exit"
import * as Cause from "effect/Cause"
import * as ScrapesRepo from "@digital-shelf/core/Scraping/repositories/ScrapesRepo"
import { expect, it } from "@effect/vitest"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { ParentInFlight } from "@digital-shelf/domain/Scraping/Errors"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import { reset, seed, history, cadenceFixture } from "../fixtures/Scraping.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Scrapes", (it) => {
  it.effect(
    "manual trigger bypasses pause, persists trace context and refuses in-flight parents",
    () =>
      Effect.gen(function* () {
        yield* reset
        const { parent } = yield* (yield* seed({ paused: true })).listing
        const service = yield* Scrapes
        const row = yield* service.trigger({ parent })
        expect(row.status).toBe("pending")
        expect(row.rootSpanId).toMatch(/^[0-9a-f]{16}$/)
        const calls = yield* (yield* ExecutionsTest).calls
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
        const report = yield* service.bulk({
          _tag: "Brand",
          brandId: fixture.brandId,
        })
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
        const report = yield* service.dispatchDue(yield* DateTime.now, 50)
        expect(report.created).toHaveLength(3)
        const rows = yield* Effect.forEach(report.created, service.get)
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
        expect(yield* service.drainPending(100)).toEqual({
          started: 1,
          alreadyActive: 1,
          recoveredFailed: 0,
          unresolved: 0,
        })
        expect(yield* service.drainPending(100)).toEqual({
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
      const report = yield* service.bulk({
        _tag: "Product",
        productId: fixture.productId,
      })
      expect(report.created).toHaveLength(102)
      expect(report.started).toBe(100)
      expect(yield* service.drainPending(102)).toEqual({
        started: 2,
        alreadyActive: 100,
        recoveredFailed: 0,
        unresolved: 0,
      })
      const calls = yield* (yield* ExecutionsTest).calls
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
        expect(yield* service.drainPending(50)).toEqual({
          started: 0,
          alreadyActive: 1,
          recoveredFailed: 1,
          unresolved: 2,
        })
        const failed = yield* service.get(terminal.id)
        expect(failed.status).toBe("failed")
        expect(failed.errorCode).toEqual(Option.some("unknown"))
        expect(failed.finishedAt).toEqual(Option.some(yield* DateTime.now))
        for (const row of [active, broken, unknown])
          expect((yield* service.get(row.id)).status).toBe("pending")
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
      const { parent } = yield* (yield* seed()).page
      const service = yield* Scrapes
      const row = yield* service.trigger({ parent })
      expect(yield* Effect.flip(service.trigger({ parent }))).toEqual(
        new ParentInFlight({ parent, scrapeId: row.id }),
      )
    }),
  )
  it.effect("disabled tracing fails clearly before creating a row", () =>
    Effect.gen(function* () {
      yield* reset
      const { parent } = yield* (yield* seed()).listing
      const service = yield* Scrapes
      const exit = yield* service
        .trigger({ parent })
        .pipe(Effect.withTracerEnabled(false), Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.pretty(exit.cause)).toContain(
          "Scrape.created needs a real span; tracing is disabled",
        )
      expect(yield* ScrapesRepo.listPending(10)).toEqual([])
    }),
  )
})
