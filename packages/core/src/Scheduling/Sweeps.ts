import { ExtractionsRepo } from "../Scraping/repositories/ExtractionsRepo.ts"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import { keysOf } from "../Scraping/R2Keys.ts"
import { traceIdOf } from "../Scraping/Trace.ts"
import { Transitions } from "../Scraping/Transitions.ts"
import { ScrapesRepo } from "../Scraping/repositories/ScrapesRepo.ts"
import { Db } from "../Sql/Db.ts"
import { R2Bucket } from "../Storage/R2Bucket.ts"
import { Executions } from "./Executions.ts"

const make = Effect.gen(function* () {
  const db = yield* Db
  const scrapesRepo = yield* ScrapesRepo
  const extractionsRepo = yield* ExtractionsRepo
  const transitions = yield* Transitions
  const executions = yield* Executions
  const bucket = yield* R2Bucket

  const bound = yield* Config.duration("STUCK_BOUND").pipe(
    Config.withDefault(Duration.minutes(5)),
    Effect.orDie,
  )

  const window = yield* Config.duration("RETENTION_WINDOW").pipe(
    Config.withDefault(Duration.days(90)),
    Effect.orDie,
  )

  const cap = yield* Config.int("RETENTION_CAP").pipe(
    Config.withDefault(50),
    Effect.orDie,
  )

  const stuck = Effect.fn("Sweeps.stuck")(function* (now: DateTime.Utc) {
    const rows = yield* scrapesRepo.listStuck(
      DateTime.subtractDuration(now, bound),
    )

    let failed = 0
    let alreadyTerminal = 0

    for (const row of rows) {
      yield* Effect.gen(function* () {
        const result = yield* transitions
          .scrape(row.id, "running", "failed", {
            finishedAt: Option.some(now),
            updatedAt: now,
            errorCode: Option.some("timeout"),
            errorMessage: Option.some("Scrape exceeded the stuck bound"),
          })
          .pipe(
            Effect.catchTag("TransitionRejected", () => Effect.succeed(null)),
          )

        if (result?.result !== "applied") {
          alreadyTerminal++

          return
        }

        failed++
        yield* executions
          .terminate("scrape", row.id)
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
        Effect.annotateSpans("shelf.scrape.id", row.id),
        Effect.linkSpans(
          Tracer.externalSpan({
            traceId: traceIdOf(row.id),
            spanId: row.rootSpanId,
          }),
        ),
      )
    }

    const extractionRows = yield* extractionsRepo.listStuck(
      DateTime.subtractDuration(now, bound),
    )

    let extractionsFailed = 0,
      extractionsAlreadyTerminal = 0

    for (const row of extractionRows) {
      yield* Effect.gen(function* () {
        const result = yield* transitions
          .extraction(row.id, "running", "failed", {
            finishedAt: Option.some(now),
            updatedAt: now,
            errorCode: Option.some("llm_timeout"),
            errorMessage: Option.some("Extraction exceeded the stuck bound"),
          })
          .pipe(
            Effect.catchTag("TransitionRejected", () => Effect.succeed(null)),
          )

        if (result?.result !== "applied") {
          extractionsAlreadyTerminal++

          return
        }

        extractionsFailed++
        yield* executions
          .terminate("extraction", row.id)
          .pipe(
            Effect.catchTag("ExecutionsError", (error) =>
              Effect.logError("Stuck Extraction termination failed", error),
            ),
          )
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
          ),
        ),
      )
    }

    return {
      examined: rows.length,
      failed,
      alreadyTerminal,
      extractionsExamined: extractionRows.length,
      extractionsFailed,
      extractionsAlreadyTerminal,
    }
  })

  const retention = Effect.fn("Sweeps.retention")(function* (
    now: DateTime.Utc,
  ) {
    const before = DateTime.subtractDuration(now, window)

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

export class Sweeps extends Context.Service<
  Sweeps,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Scheduling/Sweeps", { make }) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      ScrapesRepo.layer,
      ExtractionsRepo.layer,
      Transitions.layer,
    ]),
  )
}
