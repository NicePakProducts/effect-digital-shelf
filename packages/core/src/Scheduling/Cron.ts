import * as Cause from "effect/Cause"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Scrapes } from "../Scraping/Scrapes.ts"
import { Sweeps } from "./Sweeps.ts"

export type TickPhase =
  | "stuck"
  | "extractionDrain"
  | "scrapeDrain"
  | "cadenceDue"
  | "retention"
export type PhaseReport =
  | {
      readonly phase: TickPhase
      readonly outcome: "ok"
      readonly counts: Readonly<Record<string, number | string | null>>
    }
  | {
      readonly phase: TickPhase
      readonly outcome: "failed"
      readonly error: string
    }
export interface TickReport {
  readonly phases: ReadonlyArray<PhaseReport>
}

const make = Effect.gen(function* () {
  const scrapes = yield* Scrapes
  const sweeps = yield* Sweeps
  const cap = yield* Config.int("CRON_START_CAP").pipe(
    Config.withDefault(50),
    Effect.orDie,
  )
  const phase = <E>(
    name: TickPhase,
    work: Effect.Effect<Readonly<Record<string, number | string | null>>, E>,
  ): Effect.Effect<PhaseReport> =>
    work.pipe(
      Effect.map(
        (counts) =>
          ({ phase: name, outcome: "ok", counts }) satisfies PhaseReport,
      ),
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError(`Cron phase ${name} failed`, cause)
          return {
            phase: name,
            outcome: "failed",
            error: Cause.pretty(cause),
          } satisfies PhaseReport
        }),
      ),
      Effect.withSpan(`Cron.${name}`),
    )
  const tick = Effect.fn("Cron.tick")(
    function* (): Effect.fn.Return<TickReport> {
      const now = yield* DateTime.now
      const phases: PhaseReport[] = []
      phases.push(yield* phase("stuck", sweeps.stuck(now)))
      phases.push(
        yield* phase(
          "extractionDrain",
          Effect.as(Effect.logInfo("extraction drain not landed (#31)"), {
            started: 0,
            skipped: 0,
          }),
        ),
      )
      const drain = yield* phase("scrapeDrain", scrapes.drainPending(cap))
      phases.push(drain)
      const drainStarted =
        drain.outcome === "ok" && typeof drain.counts.started === "number"
          ? drain.counts.started
          : 0
      const remaining = Math.max(0, cap - drainStarted)
      phases.push(
        yield* phase(
          "cadenceDue",
          remaining === 0
            ? Effect.succeed({ created: 0, skipped: 0, started: 0 })
            : scrapes.dispatchDue(now, remaining).pipe(
                Effect.map((report) => ({
                  created: report.created.length,
                  skipped: report.skipped.length,
                  started: report.started,
                })),
              ),
        ),
      )
      phases.push(yield* phase("retention", sweeps.retention(now)))
      for (const entry of phases) {
        yield* Effect.annotateCurrentSpan(
          `shelf.tick.${entry.phase}.outcome`,
          entry.outcome,
        )
        if (entry.outcome === "ok")
          for (const [key, value] of Object.entries(entry.counts))
            yield* Effect.annotateCurrentSpan(
              `shelf.tick.${entry.phase}.${key}`,
              value,
            )
      }
      return { phases }
    },
  )
  return { tick }
})
export class Cron extends Context.Service<Cron, Effect.Success<typeof make>>()(
  "@digital-shelf/core/Scheduling/Cron",
  { make },
) {
  static readonly layer = Layer.effect(this, this.make)
}
