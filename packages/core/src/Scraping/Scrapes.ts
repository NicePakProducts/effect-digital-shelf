import * as Array from "effect/Array"
import type {
  GetScrapeInput,
  ScrapeContentInput,
  DrainPendingScrapesInput,
  DispatchDueScrapesInput,
} from "@digital-shelf/domain/Scraping/ScrapingManagement"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import {
  BrandNotFound,
  ProductNotFound,
  RetailerNotFound,
  ListingNotFound,
  PageNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import {
  ParentInFlight,
  type ScrapeNotFound,
} from "@digital-shelf/domain/Scraping/Errors"
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
import * as Tracer from "effect/Tracer"
import {
  isActiveExecutionStatus,
  isTerminalExecutionStatus,
  type DispatchOutcome,
} from "@digital-shelf/domain/Scraping/Execution"
import { onUniqueViolation } from "../Sql/Errors.ts"
import { Transitions } from "./Transitions.ts"
import { Db } from "../Sql/Db.ts"
import type { Cursor } from "../Sql/Keyset.ts"
import { R2Bucket, type StorageError } from "../Storage/R2Bucket.ts"
import {
  Executions,
  startBatchLimit,
  type ExecutionsError,
} from "../Scheduling/Executions.ts"
import {
  ParentsRepo,
  parentOf,
  type ScrapeTarget,
} from "./repositories/ParentsRepo.ts"
import { ScrapesRepo } from "./repositories/ScrapesRepo.ts"
import { RootTraceId, traceIdOf, traceparentOf } from "./Trace.ts"

class InFlightConflict extends Data.TaggedError("InFlightConflict") {}

export class Scrapes extends Context.Service<
  Scrapes,
  {
    readonly trigger: (
      command: TriggerScrape,
    ) => Effect.Effect<
      Scrape,
      | ListingNotFound
      | PageNotFound
      | ParentInFlight
      | SqlError
      | ExecutionsError
    >
    readonly bulk: (scope: BulkScrape) => Effect.Effect<
      {
        readonly created: ReadonlyArray<ScrapeId>
        readonly skipped: ReadonlyArray<ScrapeParent>
        readonly skippedPaused: ReadonlyArray<ScrapeParent>
        readonly started: number
      },
      | BrandNotFound
      | ProductNotFound
      | RetailerNotFound
      | SqlError
      | ExecutionsError
    >
    readonly dispatchDue: (input: DispatchDueScrapesInput) => Effect.Effect<
      {
        readonly created: ReadonlyArray<ScrapeId>
        readonly skipped: ReadonlyArray<ScrapeParent>
        readonly started: number
      },
      SqlError | ExecutionsError
    >
    readonly drainPending: (input: DrainPendingScrapesInput) => Effect.Effect<
      {
        readonly started: number
        readonly alreadyActive: number
        readonly recoveredFailed: number
        readonly unresolved: number
      },
      SqlError | ExecutionsError
    >
    readonly get: (
      input: GetScrapeInput,
    ) => Effect.Effect<Scrape, ScrapeNotFound | SqlError>
    readonly list: (options: {
      readonly listingId?: ListingId | undefined
      readonly pageId?: PageId | undefined
      readonly status?: ScrapeStatus | undefined
      readonly cursor?: Cursor | undefined
      readonly limit: number
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<Scrape>; readonly hasMore: boolean },
      SqlError
    >
    readonly content: (
      input: ScrapeContentInput,
    ) => Effect.Effect<
      Option.Option<string>,
      ScrapeNotFound | SqlError | StorageError
    >
  }
>()("@digital-shelf/core/Scraping/Scrapes", {
  make: Effect.gen(function* () {
    const db = yield* Db
    const scrapesRepo = yield* ScrapesRepo
    const parents = yield* ParentsRepo
    const transitions = yield* Transitions
    const executions = yield* Executions
    const bucket = yield* R2Bucket

    const retry = yield* Config.duration("FAILURE_RETRY_INTERVAL").pipe(
      Config.withDefault(Duration.days(1)),
    )

    const insert = (
      target: ScrapeTarget,
      trigger: "manual" | "bulk" | "cadence",
    ) =>
      Effect.gen(function* () {
        // SAFETY: A freshly generated UUID must satisfy ScrapeId; a mismatch can only be a bug.
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
              new Error(
                "Scrape.created needs a real span; tracing is disabled",
              ),
            )

          if (span.traceId !== traceIdOf(id))
            return yield* Effect.die(
              new Error(
                "Scrape.created span does not carry the Scrape trace id; provide TraceIdentity.layer (core Scraping/Trace.ts) above the tracer",
              ),
            )
          const now = yield* DateTime.now

          const values = {
            id,
            ...parentColumns(parentOf(target)),
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
              ? yield* scrapesRepo.insert(values).pipe(Effect.asSome)
              : yield* scrapesRepo.insertUnlessInFlight(values)

          const outcome: DispatchOutcome = Option.isSome(result)
            ? "created"
            : "in-flight-skip"

          yield* Effect.annotateCurrentSpan("shelf.dispatch.outcome", outcome)

          return result
        }).pipe(
          Effect.withSpan("Scrape.created", {
            root: true,
            annotations: Context.make(RootTraceId, Option.some(traceIdOf(id))),
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
      caller: Option.Option<Tracer.Span>,
    ) {
      const reports = yield* Effect.forEach(
        Array.chunksOf(rows, startBatchLimit),
        (batch) =>
          Effect.gen(function* () {
            const report = yield* executions.start(
              "scrape",
              batch.map((row) => ({
                id: row.id,
                traceparent: traceparentOf(row.id, row.rootSpanId),
              })),
            )

            for (const row of batch)
              yield* Effect.void.pipe(
                Effect.withSpan("Scrape.dispatch", {
                  parent: Tracer.externalSpan({
                    traceId: traceIdOf(row.id),
                    spanId: row.rootSpanId,
                  }),
                  links:
                    Option.isSome(caller) && caller.value.spanId !== "noop"
                      ? [{ span: caller.value, attributes: {} }]
                      : [],
                  attributes: {
                    "shelf.scrape.id": row.id,
                    "shelf.execution.kind": "scrape",
                    "shelf.dispatch.started": report.started.includes(row.id),
                  },
                }),
              )

            return report
          }),
      )

      return {
        started: reports.reduce(
          (total, report) => total + report.started.length,
          0,
        ),
        skipped: reports.flatMap((report) => report.skipped),
      }
    })

    const trigger = Effect.fn("Scrapes.trigger")(function* (
      command: TriggerScrape,
    ) {
      const parent = command.parent

      // Classify after rollback: Postgres will not allow a lookup in the failed transaction.
      const attempt = Effect.gen(function* () {
        const target = yield* parents.getTarget(parent)

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

      const created = yield* Effect.reduce(
        [0, 1],
        () => Option.none<Scrape>(),
        (created) =>
          Effect.gen(function* () {
            if (Option.isSome(created)) return created

            const inserted = yield* attempt.pipe(
              Effect.asSome,
              Effect.catchTag("InFlightConflict", () => Effect.succeedNone),
            )

            if (Option.isSome(inserted)) {
              yield* start(
                [inserted.value],
                yield* Effect.currentSpan.pipe(Effect.option),
              )

              return inserted
            }

            const existing = yield* scrapesRepo.findInFlight(parent)

            if (Option.isSome(existing))
              return yield* Effect.fail(
                new ParentInFlight({ parent, scrapeId: existing.value.id }),
              )

            return Option.none<Scrape>()
          }),
      )

      if (Option.isSome(created)) return created.value

      return yield* Effect.die(
        new Error(
          "Manual Scrape insert conflicted twice, but the in-flight row vanished before it could be identified",
        ),
      )
    })

    /**
     * Bulk and cadence share one transaction. Bulk respects effective pause,
     * so a paused Parent is counted rather than dispatched; cadence selection
     * has already excluded them.
     */
    const insertAll = (
      targets: ReadonlyArray<ScrapeTarget>,
      trigger: "bulk" | "cadence",
    ) =>
      db.transaction(() =>
        Effect.gen(function* () {
          const created: Scrape[] = []
          const skipped: ScrapeParent[] = []
          const paused: ScrapeParent[] = []

          for (const target of targets) {
            if (target.paused) {
              paused.push(parentOf(target))
              continue
            }

            const row = yield* insert(target, trigger)

            if (Option.isSome(row)) {
              created.push(row.value)
              continue
            }

            skipped.push(parentOf(target))
          }

          return { created, skipped, paused }
        }),
      )

    const bulk = Effect.fn("Scrapes.bulk")(function* (scope: BulkScrape) {
      if (!(yield* parents.containerExists(scope)))
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
        yield* parents.bulkCandidates(scope),
        "bulk",
      )

      const started = yield* start(
        report.created.slice(0, startBatchLimit),
        yield* Effect.currentSpan.pipe(Effect.option),
      )

      return {
        created: report.created.map((row) => row.id),
        skipped: report.skipped,
        skippedPaused: report.paused,
        started: started.started,
      }
    })

    const dispatchDue = Effect.fn("Scrapes.dispatchDue")(function* (
      input: DispatchDueScrapesInput,
    ) {
      const report = yield* insertAll(
        yield* parents.cadenceDue(input.now, retry, input.limit),
        "cadence",
      )

      const started = yield* start(
        report.created,
        yield* Effect.currentSpan.pipe(Effect.option),
      )

      return {
        created: report.created.map((row) => row.id),
        skipped: report.skipped,
        started: started.started,
      }
    })

    const drainPending = Effect.fn("Scrapes.drainPending")(function* (
      input: DrainPendingScrapesInput,
    ) {
      const rows = yield* scrapesRepo.listPending(input.limit)

      const report = yield* start(
        rows,
        yield* Effect.currentSpan.pipe(Effect.option),
      )

      const outcomes = yield* Effect.forEach(report.skipped, (id) =>
        Effect.gen(function* () {
          const row = rows.find((row) => row.id === id)

          if (row === undefined) return "unresolved" as const

          return yield* Effect.gen(function* () {
            const status = yield* executions.status("scrape", id)

            if (Option.isNone(status)) return "unresolved" as const

            if (isActiveExecutionStatus(status.value))
              return "already-active" as const satisfies DispatchOutcome

            if (!isTerminalExecutionStatus(status.value))
              return "unresolved" as const
            const now = yield* DateTime.now

            const result = yield* transitions
              .scrape(row.id, "pending", "failed", {
                errorCode: Option.some("unknown"),
                errorMessage: Option.some(
                  "Pending Scrape Execution is terminal",
                ),
                finishedAt: Option.some(now),
                updatedAt: now,
              })
              .pipe(
                Effect.catchTag("TransitionRejected", (error) =>
                  Effect.succeed({
                    result: "rejected" as const,
                    observed: error.observed,
                  }),
                ),
              )

            if (
              result.result === "applied" ||
              result.result === "already_applied"
            )
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
            Effect.annotateSpans("shelf.scrape.id", row.id),
            Effect.linkSpans(
              Tracer.externalSpan({
                traceId: traceIdOf(row.id),
                spanId: row.rootSpanId,
              }),
            ),
          )
        }),
      )

      return {
        started: report.started,
        alreadyActive: outcomes.filter(
          (outcome) => outcome === "already-active",
        ).length,
        recoveredFailed: outcomes.filter(
          (outcome) => outcome === "recovered-failed",
        ).length,
        unresolved: outcomes.filter((outcome) => outcome === "unresolved")
          .length,
      }
    })

    const get = Effect.fn("Scrapes.get")(function* (input: GetScrapeInput) {
      return yield* scrapesRepo.get(input.scrapeId)
    })

    /** One page of Scrapes, newest first; `hasMore` says whether to keep going. */
    const list = Effect.fn("Scrapes.list")(function* (options: {
      readonly listingId?: ListingId | undefined
      readonly pageId?: PageId | undefined
      readonly status?: ScrapeStatus | undefined
      readonly cursor?: Cursor | undefined
      readonly limit: number
    }) {
      return yield* scrapesRepo.list(options)
    })

    /**
     * The Scrape's captured HTML. `None` once retention has taken the object,
     * whether or not the row still records the key (ADR 0001).
     */
    const content = Effect.fn("Scrapes.content")(function* (
      input: ScrapeContentInput,
    ) {
      const row = yield* scrapesRepo.get(input.scrapeId)

      if (Option.isNone(row.htmlR2Key)) return Option.none<string>()

      return yield* bucket.get(row.htmlR2Key.value)
    })

    return { trigger, bulk, dispatchDue, drainPending, get, list, content }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([ScrapesRepo.layer, ParentsRepo.layer, Transitions.layer]),
  )
}
