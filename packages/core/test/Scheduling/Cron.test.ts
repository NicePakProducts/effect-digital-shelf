import {
  successfulScrape,
  extraction,
  reset,
  cadenceFixture,
  history,
  seed,
} from "../fixtures/Scraping"
import { ScrapesRepo } from "../../src/scrapes/repository"
import * as Option from "effect/Option"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Layer from "effect/Layer"
import { expect, it } from "@effect/vitest"
import { Cron } from "@app/core/cron"
import * as Effect from "effect/Effect"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core"
import { ExecutionsTest } from "../layers/Executions"

it.layer(
  CoreTest.TestLayer.pipe(
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
      const cron = yield* Cron.Service
      const report = yield* cron.tick()
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
      const executionsTest = yield* ExecutionsTest
      yield* executionsTest.failNext
      const cron = yield* Cron.Service
      const report = yield* cron.tick()
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
        const scrapesRepo = yield* ScrapesRepo.Service

        yield* reset
        const fixture = yield* seed()

        const row = yield* history(
          (yield* fixture.listing).parent,
          "pending",
          "25 hours",
        )

        const executionsTest = yield* ExecutionsTest
        yield* executionsTest.setStatus("scrape", row.id, "errored")
        const cron = yield* Cron.Service
        const report = yield* cron.tick()
        expect(report.phases[2]).toMatchObject({
          counts: { recoveredFailed: 1, started: 0 },
        })
        expect(report.phases[3]).toMatchObject({
          counts: { created: 1, started: 1 },
        })
        const failed = yield* scrapesRepo.get(row.id)
        expect(failed.status).toBe("failed")
        expect(failed.errorCode).toEqual(Option.some("unknown"))
      }).pipe(Effect.provide([ScrapesRepo.layer])),
  )
  it.effect(
    "60 pending rows consume the configured 50-start cap before cadence",
    () =>
      Effect.gen(function* () {
        const scrapesRepo = yield* ScrapesRepo.Service

        yield* reset
        const fixture = yield* seed()

        for (let i = 0; i < 60; i++)
          yield* history((yield* fixture.listing).parent, "pending", "1 hour")
        yield* fixture.listing
        yield* fixture.page
        const cron = yield* Cron.Service
        const report = yield* cron.tick()
        expect(report.phases[2]).toMatchObject({ counts: { started: 50 } })
        expect(report.phases[3]).toMatchObject({
          outcome: "ok",
          counts: { started: 0, created: 0 },
        })
        const executionsTest = yield* ExecutionsTest
        const calls = yield* executionsTest.calls
        expect(
          calls
            .filter((call) => call.operation === "start")
            .flatMap((call) => call.instances),
        ).toHaveLength(50)
        expect(yield* scrapesRepo.listPending(100)).toHaveLength(60)
      }).pipe(Effect.provide([ScrapesRepo.layer])),
  )
})

it.layer(
  CoreTest.TestLayer.pipe(
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          CRON_START_CAP: 1,
          EXTRACTION_DRAIN_CAP: 3,
        }),
      ),
    ),
  ),
  { timeout: "60 seconds" },
)("Extraction drain budget", (it) => {
  it.effect("extractions have an independent cap and drain second", () =>
    Effect.gen(function* () {
      yield* reset
      const catalog = yield* seed()

      for (let i = 0; i < 4; i++)
        yield* extraction(
          (yield* successfulScrape((yield* catalog.listing).parent)).id,
          1,
          "pending",
        )
      yield* history((yield* catalog.listing).parent, "pending", "1 hour")
      const cron = yield* Cron.Service
      const report = yield* cron.tick()
      expect(report.phases[1]).toMatchObject({
        phase: "extractionDrain",
        outcome: "ok",
        counts: { started: 3 },
      })
      expect(report.phases[2]).toMatchObject({ counts: { started: 1 } })
    }),
  )
  it.effect(
    "a failed Extraction batch reports failure and later phases still run",
    () =>
      Effect.gen(function* () {
        yield* reset
        const catalog = yield* seed()
        yield* extraction(
          (yield* successfulScrape((yield* catalog.listing).parent)).id,
          1,
          "pending",
        )
        yield* history((yield* catalog.listing).parent, "pending", "1 hour")
        const executionsTest = yield* ExecutionsTest
        yield* executionsTest.failNext
        const cron = yield* Cron.Service
        const report = yield* cron.tick()
        expect(report.phases[1]).toMatchObject({
          phase: "extractionDrain",
          outcome: "failed",
        })
        expect(
          report.phases.slice(2).every((phase) => phase.outcome === "ok"),
        ).toBe(true)
        expect(report.phases[2]).toMatchObject({ counts: { started: 1 } })
      }),
  )
})
