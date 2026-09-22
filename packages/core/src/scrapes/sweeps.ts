import { ExtractionsRepo } from "./extractions/repository"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { keysOf } from "./r2-keys"
import { traceIdOf } from "./trace"
import { Transitions } from "./transitions"
import { ScrapesRepo } from "./repository"
import { Db } from "@app/db"
import { R2Bucket } from "../storage/r2-bucket"
import { Executions } from "../executions"

export interface StuckSweepInput {
  readonly now: DateTime.Utc
}

export interface RetentionSweepInput {
  readonly now: DateTime.Utc
}

const make = Effect.gen(function* () {
  const db = yield* Db
  const scrapesRepo = yield* ScrapesRepo.Service
  const extractionsRepo = yield* ExtractionsRepo.Service
  const transitions = yield* Transitions.Service
  const executions = yield* Executions.Service
  const bucket = yield* R2Bucket.Service

  const bound = yield* Config.duration("STUCK_BOUND").pipe(
    Config.withDefault(Duration.minutes(5)),
  )

  const window = yield* Config.duration("RETENTION_WINDOW").pipe(
    Config.withDefault(Duration.days(90)),
  )

  const cap = yield* Config.int("RETENTION_CAP").pipe(Config.withDefault(50))

  const stuck = Effect.fn("Sweeps.stuck")(function* (input: StuckSweepInput) {
    const rows = yield* scrapesRepo.listStuck(
      DateTime.subtractDuration(input.now, bound),
    )

    const sweepScrape = (row: (typeof rows)[number]) =>
      Effect.gen(function* () {
        const result = yield* transitions
          .scrape(row.id, "running", "failed", {
            finishedAt: Option.some(input.now),
            updatedAt: input.now,
            errorCode: Option.some("timeout"),
            errorMessage: Option.some("Scrape exceeded the stuck bound"),
          })
          .pipe(
            Effect.catchTag("TransitionRejected", () => Effect.succeed(null)),
          )

        if (result?.result !== "applied") return "alreadyTerminal" as const

        yield* Effect.gen(function* () {
          yield* executions
            .terminate({ kind: "scrape", id: row.id })
            .pipe(
              Effect.catchTag("ExecutionsError", (error) =>
                Effect.logError("Stuck Scrape termination failed", error),
              ),
            )
          yield* bucket
            .delete(keysOf(row.id))
            .pipe(
              Effect.catchTag("StorageError", (error) =>
                Effect.logError("Stuck Scrape object deletion failed", error),
              ),
            )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Stuck Scrape sweep failed for row", row.id, cause),
          ),
        )

        return "failed" as const
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            "Stuck Scrape sweep failed for row",
            row.id,
            cause,
          ).pipe(Effect.as("errored" as const)),
        ),
        Effect.annotateSpans("shelf.scrape.id", row.id),
        Effect.linkSpans(
          Tracer.externalSpan({
            traceId: traceIdOf(row.id),
            spanId: row.rootSpanId,
          }),
        ),
      )

    const scrapes = tally(yield* Effect.forEach(rows, sweepScrape))

    const extractionRows = yield* extractionsRepo.listStuck(
      DateTime.subtractDuration(input.now, bound),
    )

    const sweepExtraction = (row: (typeof extractionRows)[number]) =>
      Effect.gen(function* () {
        const result = yield* transitions
          .extraction(row.id, "running", "failed", {
            finishedAt: Option.some(input.now),
            updatedAt: input.now,
            errorCode: Option.some("llm_timeout"),
            errorMessage: Option.some("Extraction exceeded the stuck bound"),
          })
          .pipe(
            Effect.catchTag("TransitionRejected", () => Effect.succeed(null)),
          )

        if (result?.result !== "applied") return "alreadyTerminal" as const

        yield* Effect.gen(function* () {
          yield* executions
            .terminate({ kind: "extraction", id: row.id })
            .pipe(
              Effect.catchTag("ExecutionsError", (error) =>
                Effect.logError("Stuck Extraction termination failed", error),
              ),
            )
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              "Stuck Extraction sweep failed for row",
              row.id,
              cause,
            ),
          ),
        )

        return "failed" as const
      }).pipe(
        Effect.annotateSpans({
          "shelf.scrape.id": row.scrapeId,
          "shelf.extraction.id": row.id,
          "shelf.attempt": row.attempt,
        }),
        Effect.linkSpans(
          Tracer.externalSpan({
            traceId: traceIdOf(row.scrapeId),
            spanId: row.rootSpanId,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logError(
            "Stuck Extraction sweep failed for row",
            row.id,
            cause,
          ).pipe(Effect.as("errored" as const)),
        ),
      )

    const extractions = tally(
      yield* Effect.forEach(extractionRows, sweepExtraction),
    )

    return {
      examined: rows.length,
      failed: scrapes.failed,
      alreadyTerminal: scrapes.alreadyTerminal,
      extractionsExamined: extractionRows.length,
      extractionsFailed: extractions.failed,
      extractionsAlreadyTerminal: extractions.alreadyTerminal,
    }
  })

  const retention = Effect.fn("Sweeps.retention")(function* (
    input: RetentionSweepInput,
  ) {
    const before = DateTime.subtractDuration(input.now, window)

    const ids = yield* db.transaction(() =>
      scrapesRepo.deleteExpired(before, cap),
    )

    if (ids.length > 0)
      yield* bucket
        .delete(ids.flatMap(keysOf))
        .pipe(
          Effect.catchTag("StorageError", (error) =>
            Effect.logError("Retention object deletion failed", error),
          ),
        )
    const backlog = yield* scrapesRepo.expiredBacklog(before)

    return {
      deleted: ids.length,
      remaining: backlog.remaining,
      oldestCreatedAt: Option.match(backlog.oldestCreatedAt, {
        onNone: () => null,
        onSome: DateTime.formatIso,
      }),
    }
  })

  return { stuck, retention }
})

export * as Sweeps from "./sweeps"

export interface Interface {
  readonly stuck: (input: StuckSweepInput) => Effect.Effect<
    {
      readonly examined: number
      readonly failed: number
      readonly alreadyTerminal: number
      readonly extractionsExamined: number
      readonly extractionsFailed: number
      readonly extractionsAlreadyTerminal: number
    },
    SqlError
  >
  readonly retention: (input: RetentionSweepInput) => Effect.Effect<
    {
      readonly deleted: number
      readonly remaining: number
      readonly oldestCreatedAt: string | null
    },
    SqlError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/sweeps",
) {}

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([ScrapesRepo.layer, ExtractionsRepo.layer, Transitions.layer]),
)

const tally = (
  outcomes: ReadonlyArray<"failed" | "alreadyTerminal" | "errored">,
) => ({
  failed: outcomes.filter((outcome) => outcome === "failed").length,
  alreadyTerminal: outcomes.filter((outcome) => outcome === "alreadyTerminal")
    .length,
})
