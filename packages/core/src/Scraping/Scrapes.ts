import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import {
  BrandNotFound,
  ProductNotFound,
  RetailerNotFound,
  ListingNotFound,
  PageNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import { ParentInFlight } from "@digital-shelf/domain/Scraping/Errors"
import {
  parentColumns,
  type Scrape,
  type ScrapeParent,
} from "@digital-shelf/domain/Scraping/Scrape"
import type {
  BulkScrape,
  TriggerScrape,
} from "@digital-shelf/domain/Scraping/ScrapingManagement"
import type { ScrapeStatus } from "@digital-shelf/domain/Scraping/Vocabulary"
import type { ListingId, PageId } from "@digital-shelf/domain/Shared/Ids"
import { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  isActiveExecutionStatus,
  isTerminalExecutionStatus,
  type DispatchOutcome,
} from "@digital-shelf/domain/Scraping/Execution"
import { onUniqueViolation } from "../Sql/Errors.ts"
import { transition } from "./Transitions.ts"
import { Db } from "../Sql/Db.ts"
import type { Cursor } from "../Sql/Keyset.ts"
import { R2Bucket } from "../Storage/R2Bucket.ts"
import { Executions, startBatchLimit } from "../Scheduling/Executions.ts"
import * as ParentsRepo from "./repositories/ParentsRepo.ts"
import * as ScrapesRepo from "./repositories/ScrapesRepo.ts"
import { traceparentOf } from "./Trace.ts"

class InFlightConflict extends Data.TaggedError("InFlightConflict") {}

export const requireTarget = Effect.fn("Scrapes.requireTarget")(function* (
  parent: ScrapeParent,
) {
  const target = yield* ParentsRepo.findTarget(parent)

  if (Option.isSome(target)) return target.value

  return yield* Effect.fail(
    Predicate.isTagged(parent, "Listing")
      ? new ListingNotFound({ listingId: parent.listingId })
      : new PageNotFound({ pageId: parent.pageId }),
  )
})

const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const executions = yield* Executions
  const bucket = yield* R2Bucket

  const retry = yield* Config.duration("FAILURE_RETRY_INTERVAL").pipe(
    Config.withDefault(Duration.days(1)),
    Effect.orDie,
  )

  const insert = (
    target: ParentsRepo.ScrapeTarget,
    trigger: "manual" | "bulk" | "cadence",
  ) =>
    Effect.gen(function* () {
      const id = yield* Effect.sync(() =>
        Schema.decodeUnknownSync(ScrapeId)(crypto.randomUUID()),
      )

      return yield* Effect.gen(function* () {
        const span = yield* Effect.currentSpan.pipe(
          Effect.catch(() =>
            Effect.die(
              new Error(
                "Scrape.created needs a real span; tracing is disabled",
              ),
            ),
          ),
        )

        if (span.spanId === "noop")
          return yield* Effect.die(
            new Error("Scrape.created needs a real span; tracing is disabled"),
          )
        const now = yield* DateTime.now

        const values = {
          id,
          ...parentColumns(ParentsRepo.parentOf(target)),
          status: "pending" as const,
          rootSpanId: span.spanId,
          requestUrl: target.url,
          mode: target.mode,
          country:
            target.mode === "advance"
              ? Option.some(target.country)
              : Option.none(),
          createdAt: now,
          updatedAt: now,
        }

        const result =
          trigger === "manual"
            ? yield* ScrapesRepo.insert(values).pipe(Effect.asSome)
            : yield* ScrapesRepo.insertUnlessInFlight(values)

        const outcome: DispatchOutcome = Option.isSome(result)
          ? "created"
          : "in-flight-skip"

        yield* Effect.annotateCurrentSpan("shelf.dispatch.outcome", outcome)

        return result
      }).pipe(
        Effect.withSpan("Scrape.created", {
          root: true,
          attributes: {
            "shelf.scrape.id": id,
            "shelf.parent.kind": target.parentKind,
            "shelf.parent.id": Option.getOrElse(target.listingId, () =>
              Option.getOrThrow(target.pageId),
            ),
            "shelf.retailer.id": target.retailerId,
            "shelf.trigger": trigger,
          },
        }),
      )
    })

  const start = Effect.fn("Scrapes.start")(function* (
    rows: ReadonlyArray<Scrape>,
  ) {
    let started = 0
    const skipped: string[] = []

    for (let i = 0; i < rows.length; i += startBatchLimit) {
      const report = yield* executions.start(
        "scrape",
        rows.slice(i, i + startBatchLimit).map((row) => ({
          id: row.id,
          traceparent: traceparentOf(row.id, row.rootSpanId),
        })),
      )

      started += report.started.length
      skipped.push(...report.skipped)
    }

    return { started, skipped }
  })

  const trigger = Effect.fn("Scrapes.trigger")(function* (
    command: TriggerScrape,
  ) {
    const { parent } = command

    // Classify after rollback: Postgres will not allow a lookup in the failed transaction.
    const attempt = Effect.gen(function* () {
      const target = yield* requireTarget(parent)

      return yield* db
        .transaction(() =>
          insert(
            {
              ...target,
              mode: command.mode ?? target.mode,
              country: command.country ?? target.country,
            },
            "manual",
          ),
        )
        .pipe(
          onUniqueViolation(
            Predicate.isTagged(parent, "Listing")
              ? "scrapes_listing_in_flight"
              : "scrapes_page_in_flight",
            () => new InFlightConflict(),
          ),
          Effect.map(Option.getOrThrow),
        )
    })

    for (let retry = 0; retry < 2; retry++) {
      const created = yield* attempt.pipe(
        Effect.asSome,
        Effect.catchTag("InFlightConflict", () => Effect.succeedNone),
      )

      if (Option.isSome(created)) {
        yield* start([created.value])

        return created.value
      }

      const existing = yield* ScrapesRepo.findInFlight(parent)

      if (Option.isSome(existing))
        return yield* Effect.fail(
          new ParentInFlight({ parent, scrapeId: existing.value.id }),
        )
    }

    return yield* Effect.die(
      new Error(
        "Manual Scrape insert conflicted twice, but the in-flight row vanished before it could be identified",
      ),
    )
  }, withDb)

  /**
   * Bulk and cadence share one transaction. Bulk respects effective pause,
   * so a paused Parent is counted rather than dispatched; cadence selection
   * has already excluded them.
   */
  const insertAll = (
    targets: ReadonlyArray<ParentsRepo.ScrapeTarget>,
    trigger: "bulk" | "cadence",
  ) =>
    db.transaction(() =>
      Effect.gen(function* () {
        const created: Scrape[] = []
        const skipped: ScrapeParent[] = []
        const paused: ScrapeParent[] = []

        for (const target of targets) {
          if (target.paused) {
            paused.push(ParentsRepo.parentOf(target))
            continue
          }

          const row = yield* insert(target, trigger)

          if (Option.isSome(row)) created.push(row.value)
          else skipped.push(ParentsRepo.parentOf(target))
        }

        return { created, skipped, paused }
      }),
    )

  const bulk = Effect.fn("Scrapes.bulk")(function* (scope: BulkScrape) {
    if (!(yield* ParentsRepo.containerExists(scope)))
      return yield* Effect.fail(
        Match.value(scope).pipe(
          Match.tag(
            "Brand",
            (scope) => new BrandNotFound({ brandId: scope.brandId }),
          ),
          Match.tag(
            "Product",
            (scope) => new ProductNotFound({ productId: scope.productId }),
          ),
          Match.tag(
            "Retailer",
            (scope) => new RetailerNotFound({ retailerId: scope.retailerId }),
          ),
          Match.exhaustive,
        ),
      )

    const report = yield* insertAll(
      yield* ParentsRepo.bulkCandidates(scope),
      "bulk",
    )

    const started = yield* start(report.created.slice(0, startBatchLimit))

    return {
      created: report.created.map((row) => row.id),
      skipped: report.skipped,
      skippedPaused: report.paused,
      started: started.started,
    }
  }, withDb)

  const dispatchDue = Effect.fn("Scrapes.dispatchDue")(function* (
    now: DateTime.Utc,
    limit: number,
  ) {
    const report = yield* insertAll(
      yield* ParentsRepo.cadenceDue(now, retry, limit),
      "cadence",
    )

    const started = yield* start(report.created)

    return {
      created: report.created.map((row) => row.id),
      skipped: report.skipped,
      started: started.started,
    }
  }, withDb)

  const drainPending = Effect.fn("Scrapes.drainPending")(function* (
    limit: number,
  ) {
    const rows = yield* ScrapesRepo.listPending(limit)
    const report = yield* start(rows)
    let alreadyActive = 0
    let recoveredFailed = 0
    let unresolved = 0

    for (const id of report.skipped) {
      const row = rows.find((row) => row.id === id)

      if (row === undefined) {
        unresolved++
        continue
      }

      const outcome = yield* Effect.gen(function* () {
        const status = yield* executions.status("scrape", id)

        if (Option.isNone(status)) return "unresolved" as const

        if (isActiveExecutionStatus(status.value))
          return "already-active" as const satisfies DispatchOutcome

        if (!isTerminalExecutionStatus(status.value))
          return "unresolved" as const
        const now = yield* DateTime.now

        const result = yield* transition(row.id, "pending", "failed", {
          errorCode: Option.some("unknown"),
          errorMessage: Option.some("Pending Scrape Execution is terminal"),
          finishedAt: Option.some(now),
          updatedAt: now,
        }).pipe(
          Effect.catchTag("TransitionRejected", (error) =>
            Effect.succeed({
              result: "rejected" as const,
              observed: error.observed,
            }),
          ),
        )

        if (result.result === "applied" || result.result === "already_applied")
          return "recovered-failed" as const satisfies DispatchOutcome

        return "observed" in result && result.observed === "running"
          ? ("already-active" as const)
          : ("unresolved" as const)
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logError("Scrape reconcile failed", cause),
            "unresolved" as const,
          ),
        ),
      )

      if (outcome === "already-active") alreadyActive++
      else if (outcome === "recovered-failed") recoveredFailed++
      else unresolved++
    }

    return {
      started: report.started,
      alreadyActive,
      recoveredFailed,
      unresolved,
    }
  }, withDb)

  const get = Effect.fn("Scrapes.get")(function* (id: ScrapeId) {
    return yield* ScrapesRepo.get(id)
  }, withDb)

  /** One page of Scrapes, newest first; `hasMore` says whether to keep going. */
  const list = Effect.fn("Scrapes.list")(function* (options: {
    readonly listingId?: ListingId | undefined
    readonly pageId?: PageId | undefined
    readonly status?: ScrapeStatus | undefined
    readonly cursor?: Cursor | undefined
    readonly limit: number
  }) {
    return yield* ScrapesRepo.list(options)
  }, withDb)

  /**
   * The Scrape's captured HTML. `None` once retention has taken the object,
   * whether or not the row still records the key (ADR 0001).
   */
  const content = Effect.fn("Scrapes.content")(function* (id: ScrapeId) {
    const row = yield* ScrapesRepo.get(id)

    if (Option.isNone(row.htmlR2Key)) return Option.none<string>()

    return yield* bucket.get(row.htmlR2Key.value)
  }, withDb)

  return { trigger, bulk, dispatchDue, drainPending, get, list, content }
})

export class Scrapes extends Context.Service<
  Scrapes,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Scraping/Scrapes", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
