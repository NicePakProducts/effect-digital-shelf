import * as ScrapesRepo from "@digital-shelf/core/Scraping/repositories/ScrapesRepo"
import * as Option from "effect/Option"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Layer from "effect/Layer"
import { expect, it } from "@effect/vitest"
import { Cron } from "@digital-shelf/core/Scheduling/Cron"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import { reset, cadenceFixture, history, seed } from "../fixtures/Scraping.ts"

it.layer(
  CoreTest.layerTest.pipe(
    Layer.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ CRON_START_CAP: 50 })),
    ),
  ),
  { timeout: "60 seconds" },
)("Cron", (it) => {
  it.effect("tick runs all five phases in order over cadence-due parents", () =>
    Effect.gen(function* () {
      yield* reset
      yield* TestClock.setTime(Date.UTC(2026, 8, 9))
      yield* cadenceFixture
      const report = yield* (yield* Cron).tick()
      expect(report.phases.map((entry) => entry.phase)).toEqual([
        "stuck",
        "extractionDrain",
        "scrapeDrain",
        "cadenceDue",
        "retention",
      ])
      expect(report.phases.every((entry) => entry.outcome === "ok")).toBe(true)
      expect(report.phases[3]).toMatchObject({
        counts: { created: 3, started: 3, skipped: 0 },
      })
      expect(JSON.parse(JSON.stringify(report))).toEqual(report)
    }),
  )
  it.effect("a failed drain does not prevent cadence or retention", () =>
    Effect.gen(function* () {
      yield* reset
      const fixture = yield* cadenceFixture
      yield* history(
        (yield* fixture.catalog.listing).parent,
        "pending",
        "1 hour",
      )
      yield* history(
        (yield* fixture.catalog.listing).parent,
        "failed",
        "100 days",
      )
      yield* (yield* ExecutionsTest).failNext
      const report = yield* (yield* Cron).tick()
      expect(report.phases[2]).toMatchObject({
        phase: "scrapeDrain",
        outcome: "failed",
      })
      expect(report.phases[3]).toMatchObject({
        phase: "cadenceDue",
        outcome: "ok",
      })
      expect(report.phases[4]).toMatchObject({
        phase: "retention",
        outcome: "ok",
        counts: { deleted: 1 },
      })
    }),
  )
  it.effect(
    "cron reconciles an orphan and dispatches its due Parent again",
    () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        const row = yield* history(
          (yield* fixture.listing).parent,
          "pending",
          "25 hours",
        )
        yield* (yield* ExecutionsTest).setStatus("scrape", row.id, "errored")
        const report = yield* (yield* Cron).tick()
        expect(report.phases[2]).toMatchObject({
          counts: { recoveredFailed: 1, started: 0 },
        })
        expect(report.phases[3]).toMatchObject({
          counts: { created: 1, started: 1 },
        })
        const failed = yield* ScrapesRepo.get(row.id)
        expect(failed.status).toBe("failed")
        expect(failed.errorCode).toEqual(Option.some("unknown"))
      }),
  )
  it.effect(
    "60 pending rows consume the configured 50-start cap before cadence",
    () =>
      Effect.gen(function* () {
        yield* reset
        const fixture = yield* seed()
        for (let i = 0; i < 60; i++)
          yield* history((yield* fixture.listing).parent, "pending", "1 hour")
        yield* fixture.listing
        yield* fixture.page
        const report = yield* (yield* Cron).tick()
        expect(report.phases[2]).toMatchObject({ counts: { started: 50 } })
        expect(report.phases[3]).toMatchObject({
          outcome: "ok",
          counts: { started: 0, created: 0 },
        })
        const calls = yield* (yield* ExecutionsTest).calls
        expect(
          calls
            .filter((call) => call.operation === "start")
            .flatMap((call) => call.instances),
        ).toHaveLength(50)
        expect(yield* ScrapesRepo.listPending(100)).toHaveLength(60)
      }),
  )
})
