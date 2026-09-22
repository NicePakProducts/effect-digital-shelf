import { ExtractionsErrors } from "./extractions/errors"
import { RetailersErrors, Retailers } from "../retailers"
import { ScrapesErrors } from "./errors"
import { LifecycleErrors } from "./lifecycle/errors"
import { ListingsErrors } from "../listings"
import { PagesErrors } from "../pages"
import { ProductsErrors } from "../products"
import * as Data from "effect/Data"
import { ExtractionId, type ScrapeId } from "@app/schema/ids"
import { Scrape } from "@app/schema/scrape"
import type {
  PromptKind,
  ExtractionStatus,
} from "@app/schema/scraping-vocabulary"
import { Parents } from "./parents"
import * as Array from "effect/Array"
import { Extraction } from "@app/schema/extraction"
import type { LatestExtractedData } from "@app/schema/latest-extracted-data"
import * as Predicate from "effect/Predicate"
import { extractionModel } from "./extractions/language-model"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Execution } from "@app/schema/execution"
import * as Tracer from "effect/Tracer"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  Executions,
  startBatchLimit,
  type ExecutionsError,
} from "../executions"
import { Db } from "@app/db"
import type { Cursor } from "../Sql/Keyset"
import { uniqueViolation } from "../Sql/Errors"
import { traceparentOf, traceIdOf } from "./trace"
import { Transitions } from "./transitions"
import { ExtractionsRepo } from "./extractions/repository"
import { ScrapesRepo } from "./repository"

class InFlightConflict extends Data.TaggedError("InFlightConflict") {}

export * as Extractions from "./extractions"

export { ExtractionsErrors } from "./extractions/errors"

export interface Interface {
  readonly trigger: (
    command: Extraction.Trigger,
  ) => Effect.Effect<
    Extraction.Info,
    | ScrapesErrors.NotFound
    | ListingsErrors.NotFound
    | PagesErrors.NotFound
    | ExtractionsErrors.NoSuccessfulScrape
    | ExtractionsErrors.ScrapeNotReExtractable
    | ExtractionsErrors.InFlight
    | SqlError
    | ExecutionsError
  >
  readonly bulk: (command: Extraction.Bulk) => Effect.Effect<
    {
      readonly created: ReadonlyArray<ExtractionId>
      readonly skipped: number
      readonly started: number
    },
    RetailersErrors.NotFound | SqlError | ExecutionsError
  >
  readonly redispatch: (
    input: Extraction.RedispatchInput,
  ) => Effect.Effect<
    "created" | "already-active" | "recovered-failed" | "unresolved",
    | ExtractionsErrors.NotFound
    | ScrapesErrors.NotFound
    | LifecycleErrors.TransitionRejected
    | SqlError
    | ExecutionsError
  >
  readonly drainPending: (input: Extraction.DrainPendingInput) => Effect.Effect<
    {
      readonly started: number
      readonly alreadyActive: number
      readonly recoveredFailed: number
      readonly unresolved: number
    },
    SqlError | ExecutionsError
  >
  readonly get: (
    input: Extraction.GetInput,
  ) => Effect.Effect<Extraction.Info, ExtractionsErrors.NotFound | SqlError>
  readonly list: (options: {
    readonly scrapeId?: ScrapeId | undefined
    readonly status?: ExtractionStatus | undefined
    readonly cursor?: Cursor | undefined
    readonly limit: number
  }) => Effect.Effect<
    {
      readonly items: ReadonlyArray<Extraction.Info>
      readonly hasMore: boolean
    },
    SqlError
  >
  readonly listByScrape: (
    input: Extraction.ListByScrapeInput,
  ) => Effect.Effect<ReadonlyArray<Extraction.Info>, SqlError>
  readonly latestExtractedData: (
    input: Extraction.LatestDataInput,
  ) => Effect.Effect<Option.Option<LatestExtractedData.Info>, SqlError>
  readonly latestExtractedDataForProduct: (
    input: Extraction.LatestDataForProductInput,
  ) => Effect.Effect<
    ReadonlyArray<LatestExtractedData.Info>,
    ProductsErrors.NotFound | SqlError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/extractions",
) {}

const make = Effect.gen(function* () {
  const retailers = yield* Retailers.Service
  const db = yield* Db
  const extractionsRepo = yield* ExtractionsRepo.Service
  const parents = yield* Parents.Service
  const scrapesRepo = yield* ScrapesRepo.Service
  const transitions = yield* Transitions.Service
  const executions = yield* Executions.Service
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

  type DispatchRow = Extraction.Info & { readonly rootSpanId: string }

  const start = (rows: ReadonlyArray<DispatchRow>) =>
    Effect.gen(function* () {
      const reports = yield* Effect.forEach(
        Array.chunksOf(rows, startBatchLimit),
        (batch) =>
          Effect.gen(function* () {
            const caller = yield* Effect.currentSpan.pipe(Effect.option)

            const report = yield* executions.start({
              kind: "extraction",
              instances: batch.map((row) => ({
                id: row.id,
                traceparent: traceparentOf(row.scrapeId, row.rootSpanId),
              })),
            })

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
    command: Extraction.Trigger,
  ) {
    const scrape = Predicate.isTagged(command, "Scrape")
      ? yield* scrapesRepo
          .get(command.scrapeId)
          .pipe(
            Effect.catchTag("MissingScrape", (error) =>
              Effect.fail(
                new ScrapesErrors.NotFound({ scrapeId: error.scrapeId }),
              ),
            ),
          )
      : yield* Effect.gen(function* () {
          yield* parents.getTarget(command.parent)
          const row = yield* scrapesRepo.mostRecentSuccessful(command.parent)

          return yield* Effect.fromOption(row).pipe(
            Effect.mapError(
              () =>
                new ExtractionsErrors.NoSuccessfulScrape({
                  parent: command.parent,
                }),
            ),
          )
        })

    if (scrape.status !== "success")
      return yield* new ExtractionsErrors.ScrapeNotReExtractable({
        scrapeId: scrape.id,
        reason: "not_successful",
      })

    if (Option.isNone(scrape.htmlR2Key))
      return yield* new ExtractionsErrors.ScrapeNotReExtractable({
        scrapeId: scrape.id,
        reason: "html_expired",
      })
    const target = yield* parents.getTarget(Scrape.parent(scrape))
    const kind = Scrape.parentKind(Scrape.parent(scrape))

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

    // Two attempts: one retry after an InFlightConflict rollback re-check; no other failure is retried.
    const created = yield* Effect.reduce(
      [0, 1],
      () => Option.none<Extraction.Info>(),
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
            return yield* new ExtractionsErrors.InFlight({
              scrapeId: scrape.id,
              promptKind: kind,
              extractionId: existing.value.id,
            })

          return Option.none<Extraction.Info>()
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
    command: Extraction.Bulk,
  ) {
    if (
      !(yield* parents.containerExists(
        Scrape.Bulk.members[2].make({
          retailerId: command.retailerId,
        }),
      ))
    )
      return yield* new RetailersErrors.NotFound({
        retailerId: command.retailerId,
      })

    const retailer = yield* retailers.get({ retailerId: command.retailerId })

    const prompt =
      command.promptKind === "listing"
        ? retailer.listingExtractPrompt
        : retailer.pageExtractPrompt

    const report = yield* db.transaction(() =>
      Effect.gen(function* () {
        const candidates = yield* extractionsRepo.bulkCandidates(
          command.retailerId,
          command.promptKind,
          prompt,
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
              prompt,
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
      const status = yield* executions.status({
        kind: "extraction",
        id: row.id,
      })

      if (Option.isNone(status)) return "unresolved" as const

      if (Execution.isActiveStatus(status.value))
        return "already-active" as const

      if (!Execution.isTerminalStatus(status.value))
        return "unresolved" as const
      const now = yield* DateTime.now

      return yield* transitions
        .extraction(row.id, "pending", "failed", {
          errorCode: Option.some("unknown"),
          errorMessage: Option.some("Pending Extraction Execution is terminal"),
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
    input: Extraction.RedispatchInput,
  ) {
    const row = yield* extractionsRepo.get(input.extractionId).pipe(
      Effect.catchTag("MissingExtraction", (error) =>
        Effect.fail(
          new ExtractionsErrors.NotFound({
            extractionId: error.extractionId,
          }),
        ),
      ),
    )

    if (row.status !== "pending")
      return yield* new LifecycleErrors.TransitionRejected({
        kind: "extraction",
        id: input.extractionId,
        from: "pending",
        to: "running",
        observed: row.status,
      })

    const scrape = yield* scrapesRepo
      .get(row.scrapeId)
      .pipe(
        Effect.catchTag("MissingScrape", (error) =>
          Effect.fail(new ScrapesErrors.NotFound({ scrapeId: error.scrapeId })),
        ),
      )

    const report = yield* start([{ ...row, rootSpanId: scrape.rootSpanId }])

    return report.started > 0
      ? ("created" as const)
      : yield* reconcile({ ...row, rootSpanId: scrape.rootSpanId })
  })

  const drainPending = Effect.fn("Extractions.drainPending")(function* (
    input: Extraction.DrainPendingInput,
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
      alreadyActive: outcomes.filter((outcome) => outcome === "already-active")
        .length,
      recoveredFailed: outcomes.filter(
        (outcome) => outcome === "recovered-failed",
      ).length,
      unresolved: outcomes.filter((outcome) => outcome === "unresolved").length,
    }
  })

  const get = Effect.fn("Extractions.get")(function* (
    input: Extraction.GetInput,
  ) {
    return yield* extractionsRepo.get(input.extractionId).pipe(
      Effect.catchTag("MissingExtraction", (error) =>
        Effect.fail(
          new ExtractionsErrors.NotFound({
            extractionId: error.extractionId,
          }),
        ),
      ),
    )
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
    input: Extraction.ListByScrapeInput,
  ) {
    return yield* extractionsRepo.listByScrape(input.scrapeId)
  })

  const latestExtractedData = Effect.fn("Extractions.latestExtractedData")(
    function* (input: Extraction.LatestDataInput) {
      return yield* extractionsRepo.latestExtractedData(input.parent)
    },
  )

  const latestExtractedDataForProduct = Effect.fn(
    "Extractions.latestExtractedDataForProduct",
  )(function* (input: Extraction.LatestDataForProductInput) {
    if (
      !(yield* parents.containerExists(
        Scrape.Bulk.members[1].make({ productId: input.productId }),
      ))
    )
      return yield* new ProductsErrors.NotFound({ productId: input.productId })

    return yield* extractionsRepo.latestExtractedDataForProduct(input.productId)
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
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([
    Retailers.layer,
    ExtractionsRepo.layer,
    Parents.layer,
    ScrapesRepo.layer,
    Transitions.layer,
  ]),
)
