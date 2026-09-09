import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { keysOf } from "../Scraping/R2Keys.ts"
import { transition } from "../Scraping/Transitions.ts"
import * as ScrapesRepo from "../Scraping/repositories/ScrapesRepo.ts"
import { Db } from "../Sql/Db.ts"
import { R2Bucket } from "../Storage/R2Bucket.ts"
import { Executions } from "./Executions.ts"

const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
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
    const rows = yield* ScrapesRepo.listStuck(
      DateTime.subtractDuration(now, bound),
    )
    let failed = 0
    let alreadyTerminal = 0
    for (const row of rows) {
      yield* Effect.gen(function* () {
        const result = yield* transition(row.id, "running", "failed", {
          finishedAt: Option.some(now),
          updatedAt: now,
          errorCode: Option.some("timeout"),
          errorMessage: Option.some("Scrape exceeded the stuck bound"),
        }).pipe(
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
      )
    }
    return { examined: rows.length, failed, alreadyTerminal }
  }, withDb)
  const retention = Effect.fn("Sweeps.retention")(function* (
    now: DateTime.Utc,
  ) {
    const before = DateTime.subtractDuration(now, window)
    const ids = yield* db.transaction(() =>
      ScrapesRepo.deleteExpired(before, cap),
    )
    if (ids.length > 0)
      yield* bucket
        .delete(ids.flatMap(keysOf))
        .pipe(
          Effect.catchTag("StorageError", (error) =>
            Effect.logError("Retention object deletion failed", error),
          ),
        )
    const backlog = yield* ScrapesRepo.expiredBacklog(before)
    return {
      deleted: ids.length,
      remaining: backlog.remaining,
      oldestCreatedAt: Option.match(backlog.oldestCreatedAt, {
        onNone: () => null,
        onSome: DateTime.formatIso,
      }),
    }
  }, withDb)
  return { stuck, retention }
})
export class Sweeps extends Context.Service<
  Sweeps,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Scheduling/Sweeps", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
