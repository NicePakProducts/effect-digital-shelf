import * as Array from "effect/Array"
import type {
  GetExtractionInput,
  RedispatchExtractionInput,
  DrainPendingExtractionsInput,
  ListExtractionsByScrapeInput,
  LatestExtractedDataInput,
  LatestExtractedDataForProductInput,
} from "@digital-shelf/domain/Scraping/ScrapingManagement"
import type { LatestExtractedData } from "@digital-shelf/domain/Scraping/LatestExtractedData"
import type {
  ListingNotFound,
  PageNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import type {
  ExtractionNotFound,
  ScrapeNotFound,
} from "@digital-shelf/domain/Scraping/Errors"
import * as Predicate from "effect/Predicate"
import { extractionModel } from "../Providers/LanguageModel.ts"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  ProductNotFound,
  RetailerNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import {
  ExtractionInFlight,
  NoSuccessfulScrape,
  ScrapeNotReExtractable,
} from "@digital-shelf/domain/Scraping/Errors"
import {
  isActiveExecutionStatus,
  isTerminalExecutionStatus,
} from "@digital-shelf/domain/Scraping/Execution"
import type { Extraction } from "@digital-shelf/domain/Scraping/Extraction"
import { parent, parentKind } from "@digital-shelf/domain/Scraping/Scrape"
import {
  BulkReExtract,
  TriggerExtraction,
  BulkScrape,
} from "@digital-shelf/domain/Scraping/ScrapingManagement"
import type {
  ExtractionStatus,
  PromptKind,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import { ExtractionId, type ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import * as Tracer from "effect/Tracer"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  Executions,
  startBatchLimit,
  type ExecutionsError,
} from "../Scheduling/Executions.ts"
import { Db } from "../Sql/Db.ts"
import type { Cursor } from "../Sql/Keyset.ts"
import { uniqueViolation } from "../Sql/Errors.ts"
import { traceparentOf, traceIdOf } from "./Trace.ts"
import { TransitionRejected, Transitions } from "./Transitions.ts"
import { ExtractionsRepo } from "./repositories/ExtractionsRepo.ts"
import { ParentsRepo } from "./repositories/ParentsRepo.ts"
import { ScrapesRepo } from "./repositories/ScrapesRepo.ts"

class InFlightConflict extends Data.TaggedError("InFlightConflict") {}

export class Extractions extends Context.Service<
  Extractions,
  {
    readonly trigger: (
      command: TriggerExtraction,
    ) => Effect.Effect<
      Extraction,
      | ScrapeNotFound
      | ListingNotFound
      | PageNotFound
      | NoSuccessfulScrape
      | ScrapeNotReExtractable
      | ExtractionInFlight
      | SqlError
      | ExecutionsError
    >
    readonly bulk: (command: BulkReExtract) => Effect.Effect<
      {
        readonly created: ReadonlyArray<ExtractionId>
        readonly skipped: number
        readonly started: number
      },
      RetailerNotFound | SqlError | ExecutionsError
    >
    readonly redispatch: (
      input: RedispatchExtractionInput,
    ) => Effect.Effect<
      "created" | "already-active" | "recovered-failed" | "unresolved",
      | ExtractionNotFound
      | ScrapeNotFound
      | TransitionRejected
      | SqlError
      | ExecutionsError
    >
    readonly drainPending: (
      input: DrainPendingExtractionsInput,
    ) => Effect.Effect<
      {
        readonly started: number
        readonly alreadyActive: number
        readonly recoveredFailed: number
        readonly unresolved: number
      },
      SqlError | ExecutionsError
    >
    readonly get: (
      input: GetExtractionInput,
    ) => Effect.Effect<Extraction, ExtractionNotFound | SqlError>
    readonly list: (options: {
      readonly scrapeId?: ScrapeId | undefined
      readonly status?: ExtractionStatus | undefined
      readonly cursor?: Cursor | undefined
      readonly limit: number
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<Extraction>; readonly hasMore: boolean },
      SqlError
    >
    readonly listByScrape: (
      input: ListExtractionsByScrapeInput,
    ) => Effect.Effect<ReadonlyArray<Extraction>, SqlError>
    readonly latestExtractedData: (
      input: LatestExtractedDataInput,
    ) => Effect.Effect<Option.Option<LatestExtractedData>, SqlError>
    readonly latestExtractedDataForProduct: (
      input: LatestExtractedDataForProductInput,
    ) => Effect.Effect<
      ReadonlyArray<LatestExtractedData>,
      ProductNotFound | SqlError
    >
  }
>()("@digital-shelf/core/Scraping/Extractions", {
  make: Effect.gen(function* () {
    const db = yield* Db
    const extractionsRepo = yield* ExtractionsRepo
    const parents = yield* ParentsRepo
    const scrapesRepo = yield* ScrapesRepo
    const transitions = yield* Transitions
    const executions = yield* Executions
    const model = yield* extractionModel

    const insert = (
      scrapeId: ScrapeId,
      rootSpanId: string,
      promptKind: PromptKind,
      prompt: string,
      trigger: "manual" | "bulk",
    ) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now

        const row = yield* extractionsRepo.allocate(
          {
            // SAFETY: A freshly generated UUID must satisfy ExtractionId; a mismatch can only be a bug.
            id: yield* Schema.decodeEffect(ExtractionId)(
              crypto.randomUUID(),
            ).pipe(Effect.orDie),
            scrapeId,
            promptKind,
            promptSnapshot: prompt,
            model,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          },
          { tolerateConflict: trigger === "bulk" },
        )

        if (Option.isSome(row))
          yield* Effect.void.pipe(
            Effect.withSpan("Extraction.created", {
              attributes: {
                "shelf.extraction.id": row.value.id,
                "shelf.scrape.id": scrapeId,
                "shelf.attempt": row.value.attempt,
                "shelf.trigger": trigger,
              },
            }),
            Effect.withParentSpan(
              Tracer.externalSpan({
                traceId: traceIdOf(scrapeId),
                spanId: rootSpanId,
              }),
            ),
          )

        return row
      })

    type DispatchRow = Extraction & { readonly rootSpanId: string }

    const start = (rows: ReadonlyArray<DispatchRow>) =>
      Effect.gen(function* () {
        const reports = yield* Effect.forEach(
          Array.chunksOf(rows, startBatchLimit),
          (batch) =>
            Effect.gen(function* () {
              const caller = yield* Effect.currentSpan.pipe(Effect.option)

              const report = yield* executions.start(
                "extraction",
                batch.map((row) => ({
                  id: row.id,
                  traceparent: traceparentOf(row.scrapeId, row.rootSpanId),
                })),
              )

              for (const row of batch)
                yield* Effect.void.pipe(
                  Effect.withSpan("Extraction.dispatch", {
                    parent: Tracer.externalSpan({
                      traceId: traceIdOf(row.scrapeId),
                      spanId: row.rootSpanId,
                    }),
                    links:
                      Option.isSome(caller) && caller.value.spanId !== "noop"
                        ? [{ span: caller.value, attributes: {} }]
                        : [],
                    attributes: {
                      "shelf.scrape.id": row.scrapeId,
                      "shelf.extraction.id": row.id,
                      "shelf.attempt": row.attempt,
                      "shelf.execution.kind": "extraction",
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

    const trigger = Effect.fn("Extractions.trigger")(function* (
      command: TriggerExtraction,
    ) {
      const scrape = Predicate.isTagged(command, "Scrape")
        ? yield* scrapesRepo.get(command.scrapeId)
        : yield* Effect.gen(function* () {
            yield* parents.getTarget(command.parent)
            const row = yield* scrapesRepo.mostRecentSuccessful(command.parent)

            return yield* Effect.fromOption(row).pipe(
              Effect.mapError(
                () => new NoSuccessfulScrape({ parent: command.parent }),
              ),
            )
          })

      if (scrape.status !== "success")
        return yield* new ScrapeNotReExtractable({
          scrapeId: scrape.id,
          reason: "not_successful",
        })

      if (Option.isNone(scrape.htmlR2Key))
        return yield* new ScrapeNotReExtractable({
          scrapeId: scrape.id,
          reason: "html_expired",
        })
      const target = yield* parents.getTarget(parent(scrape))
      const kind = parentKind(parent(scrape))

      const attempt = db
        .transaction(() =>
          insert(scrape.id, scrape.rootSpanId, kind, target.prompt, "manual"),
        )
        .pipe(
          Effect.catchTag(
            "SqlError",
            (error): Effect.Effect<never, InFlightConflict | SqlError> => {
              const name = uniqueViolation(error)

              return Option.isSome(name) &&
                [
                  "extractions_scrape_in_flight",
                  "extractions_scrape_id_attempt",
                ].includes(name.value)
                ? Effect.fail(new InFlightConflict())
                : Effect.fail(error)
            },
          ),
          Effect.catchTag("InFlightConflict", () => Effect.succeedNone),
        )

      const created = yield* Effect.reduce(
        [0, 1],
        () => Option.none<Extraction>(),
        (created) =>
          Effect.gen(function* () {
            if (Option.isSome(created)) return created

            const row = yield* attempt

            if (Option.isSome(row)) {
              yield* start([{ ...row.value, rootSpanId: scrape.rootSpanId }])

              return row
            }

            const existing = yield* extractionsRepo.findInFlight(scrape.id)

            if (Option.isSome(existing))
              return yield* new ExtractionInFlight({
                scrapeId: scrape.id,
                promptKind: kind,
                extractionId: existing.value.id,
              })

            return Option.none<Extraction>()
          }),
      )

      if (Option.isSome(created)) return created.value

      return yield* Effect.die(
        new Error(
          "Manual Extraction insert conflicted twice, but the in-flight row vanished before it could be identified",
        ),
      )
    })

    const bulk = Effect.fn("Extractions.bulk")(function* (
      command: BulkReExtract,
    ) {
      if (
        !(yield* parents.containerExists(
          BulkScrape.members[2].make({
            retailerId: command.retailerId,
          }),
        ))
      )
        return yield* new RetailerNotFound({ retailerId: command.retailerId })

      const prompt = yield* extractionsRepo.retailerPrompt(
        command.retailerId,
        command.promptKind,
      )

      if (Option.isNone(prompt))
        return yield* new RetailerNotFound({ retailerId: command.retailerId })

      const report = yield* db.transaction(() =>
        Effect.gen(function* () {
          const candidates = yield* extractionsRepo.bulkCandidates(
            command.retailerId,
            command.promptKind,
            prompt.value,
            model,
          )

          const results = yield* Effect.forEach(candidates, (candidate) =>
            Effect.gen(function* () {
              if (candidate.matching || !candidate.hasHtml)
                return Option.none<DispatchRow>()

              const row = yield* insert(
                candidate.scrapeId,
                candidate.rootSpanId,
                candidate.promptKind,
                prompt.value,
                "bulk",
              )

              return Option.map(row, (row) => ({
                ...row,
                rootSpanId: candidate.rootSpanId,
              }))
            }),
          )

          const created = Array.getSomes(results)

          return { created, skipped: candidates.length - created.length }
        }),
      )

      const started = yield* start(report.created.slice(0, startBatchLimit))

      return {
        created: report.created.map((row) => row.id),
        skipped: report.skipped,
        started: started.started,
      }
    })

    const reconcile = (row: DispatchRow) =>
      Effect.gen(function* () {
        const status = yield* executions.status("extraction", row.id)

        if (Option.isNone(status)) return "unresolved" as const

        if (isActiveExecutionStatus(status.value))
          return "already-active" as const

        if (!isTerminalExecutionStatus(status.value))
          return "unresolved" as const
        const now = yield* DateTime.now

        return yield* transitions
          .extraction(row.id, "pending", "failed", {
            errorCode: Option.some("unknown"),
            errorMessage: Option.some(
              "Pending Extraction Execution is terminal",
            ),
            finishedAt: Option.some(now),
            updatedAt: now,
          })
          .pipe(
            Effect.as("recovered-failed" as const),
            Effect.catchTag("TransitionRejected", (error) =>
              Effect.succeed(
                error.observed === "running"
                  ? ("already-active" as const)
                  : ("unresolved" as const),
              ),
            ),
          )
      }).pipe(
        Effect.withParentSpan(
          Tracer.externalSpan({
            traceId: traceIdOf(row.scrapeId),
            spanId: row.rootSpanId,
          }),
        ),
        Effect.annotateSpans({
          "shelf.extraction.id": row.id,
          "shelf.scrape.id": row.scrapeId,
          "shelf.attempt": row.attempt,
        }),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logError("Extraction reconcile failed", cause),
            "unresolved" as const,
          ),
        ),
      )

    const redispatch = Effect.fn("Extractions.redispatch")(function* (
      input: RedispatchExtractionInput,
    ) {
      const row = yield* extractionsRepo.get(input.extractionId)

      if (row.status !== "pending")
        return yield* new TransitionRejected({
          kind: "extraction",
          id: input.extractionId,
          from: "pending",
          to: "running",
          observed: row.status,
        })
      const scrape = yield* scrapesRepo.get(row.scrapeId)
      const report = yield* start([{ ...row, rootSpanId: scrape.rootSpanId }])

      return report.started > 0
        ? ("created" as const)
        : yield* reconcile({ ...row, rootSpanId: scrape.rootSpanId })
    })

    const drainPending = Effect.fn("Extractions.drainPending")(function* (
      input: DrainPendingExtractionsInput,
    ) {
      const rows = yield* extractionsRepo.listPending(input.limit)
      const report = yield* start(rows)

      const outcomes = yield* Effect.forEach(report.skipped, (id) =>
        Effect.gen(function* () {
          const row = rows.find((row) => row.id === id)

          return row === undefined
            ? ("unresolved" as const)
            : yield* reconcile(row)
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

    const get = Effect.fn("Extractions.get")(function* (
      input: GetExtractionInput,
    ) {
      return yield* extractionsRepo.get(input.extractionId)
    })

    /** One page of Extractions, newest first; `hasMore` says whether to keep going. */
    const list = Effect.fn("Extractions.list")(function* (options: {
      readonly scrapeId?: ScrapeId | undefined
      readonly status?: ExtractionStatus | undefined
      readonly cursor?: Cursor | undefined
      readonly limit: number
    }) {
      return yield* extractionsRepo.list(options)
    })

    const listByScrape = Effect.fn("Extractions.listByScrape")(function* (
      input: ListExtractionsByScrapeInput,
    ) {
      return yield* extractionsRepo.listByScrape(input.scrapeId)
    })

    const latestExtractedData = Effect.fn("Extractions.latestExtractedData")(
      function* (input: LatestExtractedDataInput) {
        return yield* extractionsRepo.latestExtractedData(input.parent)
      },
    )

    const latestExtractedDataForProduct = Effect.fn(
      "Extractions.latestExtractedDataForProduct",
    )(function* (input: LatestExtractedDataForProductInput) {
      if (
        !(yield* parents.containerExists(
          BulkScrape.members[1].make({ productId: input.productId }),
        ))
      )
        return yield* new ProductNotFound({ productId: input.productId })

      return yield* extractionsRepo.latestExtractedDataForProduct(
        input.productId,
      )
    })

    return {
      trigger,
      bulk,
      redispatch,
      drainPending,
      get,
      list,
      listByScrape,
      latestExtractedData,
      latestExtractedDataForProduct,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      ExtractionsRepo.layer,
      ParentsRepo.layer,
      ScrapesRepo.layer,
      Transitions.layer,
    ]),
  )
}
