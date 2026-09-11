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
import {
  parent,
  parentKind,
  type ScrapeParent,
} from "@digital-shelf/domain/Scraping/Scrape"
import {
  BulkReExtract,
  TriggerExtraction,
  BulkScrape,
} from "@digital-shelf/domain/Scraping/ScrapingManagement"
import type {
  ExtractionStatus,
  PromptKind,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import {
  ExtractionId,
  type ProductId,
  type ScrapeId,
} from "@digital-shelf/domain/Shared/Ids"
import * as Tracer from "effect/Tracer"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Executions, startBatchLimit } from "../Scheduling/Executions.ts"
import { Db } from "../Sql/Db.ts"
import type { Cursor } from "../Sql/Keyset.ts"
import { uniqueViolation } from "../Sql/Errors.ts"
import { requireTarget } from "./Scrapes.ts"
import { traceparentOf, traceIdOf } from "./Trace.ts"
import { TransitionRejected, transitionExtraction } from "./Transitions.ts"
import * as ExtractionsRepo from "./repositories/ExtractionsRepo.ts"
import * as ParentsRepo from "./repositories/ParentsRepo.ts"
import * as ScrapesRepo from "./repositories/ScrapesRepo.ts"

class InFlightConflict extends Data.TaggedError("InFlightConflict") {}

const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const executions = yield* Executions
  const model = yield* extractionModel.pipe(Effect.orDie)

  const insert = (
    scrapeId: ScrapeId,
    rootSpanId: string,
    promptKind: PromptKind,
    prompt: string,
    trigger: "manual" | "bulk",
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now

      const row = yield* ExtractionsRepo.allocate(
        {
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
      let started = 0
      const skipped: string[] = []

      for (let i = 0; i < rows.length; i += startBatchLimit) {
        const report = yield* executions.start(
          "extraction",
          rows.slice(i, i + startBatchLimit).map((row) => ({
            id: row.id,
            traceparent: traceparentOf(row.scrapeId, row.rootSpanId),
          })),
        )

        started += report.started.length
        skipped.push(...report.skipped)
      }

      return { started, skipped }
    })

  const trigger = Effect.fn("Extractions.trigger")(function* (
    command: TriggerExtraction,
  ) {
    const scrape = Predicate.isTagged(command, "Scrape")
      ? yield* ScrapesRepo.get(command.scrapeId)
      : yield* Effect.gen(function* () {
          yield* requireTarget(command.parent)
          const row = yield* ScrapesRepo.mostRecentSuccessful(command.parent)

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
    const target = yield* requireTarget(parent(scrape))
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

    for (let retry = 0; retry < 2; retry++) {
      const row = yield* attempt

      if (Option.isSome(row)) {
        yield* start([{ ...row.value, rootSpanId: scrape.rootSpanId }])

        return row.value
      }

      const existing = yield* ExtractionsRepo.findInFlight(scrape.id)

      if (Option.isSome(existing))
        return yield* new ExtractionInFlight({
          scrapeId: scrape.id,
          promptKind: kind,
          extractionId: existing.value.id,
        })
    }

    return yield* Effect.die(
      new Error(
        "Manual Extraction insert conflicted twice, but the in-flight row vanished before it could be identified",
      ),
    )
  }, withDb)

  const bulk = Effect.fn("Extractions.bulk")(function* (
    command: BulkReExtract,
  ) {
    if (
      !(yield* ParentsRepo.containerExists(
        BulkScrape.members[2].make({
          retailerId: command.retailerId,
        }),
      ))
    )
      return yield* new RetailerNotFound({ retailerId: command.retailerId })

    const prompt = yield* ExtractionsRepo.retailerPrompt(
      command.retailerId,
      command.promptKind,
    )

    if (Option.isNone(prompt))
      return yield* new RetailerNotFound({ retailerId: command.retailerId })

    const report = yield* db.transaction(() =>
      Effect.gen(function* () {
        const candidates = yield* ExtractionsRepo.bulkCandidates(
          command.retailerId,
          command.promptKind,
          prompt.value,
          model,
        )

        let skipped = 0
        const created: DispatchRow[] = []

        for (const candidate of candidates) {
          if (candidate.matching || !candidate.hasHtml) {
            skipped++
            continue
          }

          const row = yield* insert(
            candidate.scrapeId,
            candidate.rootSpanId,
            candidate.promptKind,
            prompt.value,
            "bulk",
          )

          if (Option.isSome(row))
            created.push({ ...row.value, rootSpanId: candidate.rootSpanId })
          else skipped++
        }

        return { created, skipped }
      }),
    )

    const started = yield* start(report.created.slice(0, startBatchLimit))

    return {
      created: report.created.map((row) => row.id),
      skipped: report.skipped,
      started: started.started,
    }
  }, withDb)

  const reconcile = (row: DispatchRow) =>
    Effect.gen(function* () {
      const status = yield* executions.status("extraction", row.id)

      if (Option.isNone(status)) return "unresolved" as const

      if (isActiveExecutionStatus(status.value))
        return "already-active" as const

      if (!isTerminalExecutionStatus(status.value)) return "unresolved" as const
      const now = yield* DateTime.now

      return yield* transitionExtraction(row.id, "pending", "failed", {
        errorCode: Option.some("unknown"),
        errorMessage: Option.some("Pending Extraction Execution is terminal"),
        finishedAt: Option.some(now),
        updatedAt: now,
      }).pipe(
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
    id: ExtractionId,
  ) {
    const row = yield* ExtractionsRepo.get(id)

    if (row.status !== "pending")
      return yield* new TransitionRejected({
        kind: "extraction",
        id,
        from: "pending",
        to: "running",
        observed: row.status,
      })
    const scrape = yield* ScrapesRepo.get(row.scrapeId)
    const report = yield* start([{ ...row, rootSpanId: scrape.rootSpanId }])

    return report.started > 0
      ? ("created" as const)
      : yield* reconcile({ ...row, rootSpanId: scrape.rootSpanId })
  }, withDb)

  const drainPending = Effect.fn("Extractions.drainPending")(function* (
    limit: number,
  ) {
    const rows = yield* ExtractionsRepo.listPending(limit)
    const report = yield* start(rows)

    let alreadyActive = 0,
      recoveredFailed = 0,
      unresolved = 0

    for (const id of report.skipped) {
      const row = rows.find((row) => row.id === id)
      const outcome = row === undefined ? "unresolved" : yield* reconcile(row)

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

  const get = Effect.fn("Extractions.get")(function* (id: ExtractionId) {
    return yield* ExtractionsRepo.get(id)
  }, withDb)

  /** One page of Extractions, newest first; `hasMore` says whether to keep going. */
  const list = Effect.fn("Extractions.list")(function* (options: {
    readonly scrapeId?: ScrapeId | undefined
    readonly status?: ExtractionStatus | undefined
    readonly cursor?: Cursor | undefined
    readonly limit: number
  }) {
    return yield* ExtractionsRepo.list(options)
  }, withDb)

  const listByScrape = Effect.fn("Extractions.listByScrape")(function* (
    id: ScrapeId,
  ) {
    return yield* ExtractionsRepo.listByScrape(id)
  }, withDb)

  const latestExtractedData = Effect.fn("Extractions.latestExtractedData")(
    function* (parent: ScrapeParent) {
      return yield* ExtractionsRepo.latestExtractedData(parent)
    },
    withDb,
  )

  const latestExtractedDataForProduct = Effect.fn(
    "Extractions.latestExtractedDataForProduct",
  )(function* (id: ProductId) {
    if (
      !(yield* ParentsRepo.containerExists(
        BulkScrape.members[1].make({ productId: id }),
      ))
    )
      return yield* new ProductNotFound({ productId: id })

    return yield* ExtractionsRepo.latestExtractedDataForProduct(id)
  }, withDb)

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

export class Extractions extends Context.Service<
  Extractions,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Scraping/Extractions", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
