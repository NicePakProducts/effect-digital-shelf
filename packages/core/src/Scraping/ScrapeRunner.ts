import * as Predicate from "effect/Predicate"
import { extractionModel } from "../Providers/LanguageModel.ts"
import { parent, parentKind } from "@digital-shelf/domain/Scraping/Scrape"
import { ScrapeEnvelope } from "@digital-shelf/domain/Scraping/ScrapeEnvelope"
import {
  ScrapeErrorCode,
  ScrapeMode,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import {
  RetailerId,
  type ExtractionId,
  type ScrapeId,
} from "@digital-shelf/domain/Shared/Ids"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ScrapeProviders } from "../Providers/ScrapeProviders.ts"
import { Executions } from "../Scheduling/Executions.ts"
import { Db } from "../Sql/Db.ts"
import { R2Bucket } from "../Storage/R2Bucket.ts"
import * as R2Keys from "./R2Keys.ts"
import { requireTarget } from "./Scrapes.ts"
import { traceparentOf } from "./Trace.ts"
import { transition, isTerminal } from "./Transitions.ts"
import * as ExtractionsRepo from "./repositories/ExtractionsRepo.ts"
import * as ParentsRepo from "./repositories/ParentsRepo.ts"
import * as ScrapesRepo from "./repositories/ScrapesRepo.ts"

export { TransitionRejected } from "./Transitions.ts"

/** Workflow values contain nulls, never Effect Options. */
export const FetchEnvelope = Schema.Struct({
  ...ScrapeEnvelope.fields,
  ipInfo: Schema.NullOr(Schema.Json),
  session: Schema.NullOr(Schema.String),
})

export const FetchOutcome = Schema.Union([
  Schema.TaggedStruct("fetched", {
    envelope: FetchEnvelope,
    htmlKey: Schema.String,
    rawKey: Schema.String,
    truncated: Schema.Boolean,
  }),
  Schema.TaggedStruct("failed", {
    code: ScrapeErrorCode,
    message: Schema.String,
    retryable: Schema.Boolean,
    attempts: Schema.Int,
    detail: Schema.NullOr(Schema.Json),
  }),
])

export type FetchOutcome = typeof FetchOutcome.Type

export const FetchTarget = Schema.Struct({
  url: Schema.String,
  mode: ScrapeMode,
  country: Schema.NullOr(Schema.String),
  retailerId: RetailerId,
  prompt: Schema.String,
  rootSpanId: Schema.String,
})

export type FetchTarget = typeof FetchTarget.Type

const capText = (text: string, cap: number) => {
  const encoded = new TextEncoder().encode(text)

  if (encoded.length <= cap) return { text, truncated: false }
  let end = Math.max(0, cap)

  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--

  return {
    text: new TextDecoder().decode(encoded.subarray(0, end)),
    truncated: true,
  }
}

const jsonDetail = Schema.is(Schema.Json)

const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const providers = yield* ScrapeProviders
  const bucket = yield* R2Bucket
  const executions = yield* Executions

  const deadline = yield* Config.duration("SCRAPE_DEADLINE").pipe(
    Config.withDefault(Duration.seconds(180)),
    Effect.orDie,
  )

  const cap = yield* Config.int("INNER_TEXT_CAP_BYTES").pipe(
    Config.withDefault(262144),
    Effect.orDie,
  )

  const model = yield* extractionModel.pipe(Effect.orDie)

  const claim = Effect.fn("ScrapeRunner.claim")(function* (id: ScrapeId) {
    const now = yield* DateTime.now

    const { row } = yield* transition(id, "pending", "running", {
      startedAt: Option.some(now),
      updatedAt: now,
    })

    const target = yield* requireTarget(parent(row))

    return {
      url: row.requestUrl,
      mode: row.mode,
      country: Option.getOrNull(row.country),
      retailerId: target.retailerId,
      prompt: target.prompt,
      rootSpanId: row.rootSpanId,
    }
  }, withDb)

  const fetch = Effect.fn("ScrapeRunner.fetch")(function* (
    id: ScrapeId,
    target: FetchTarget,
  ) {
    return yield* Effect.gen(function* () {
      const result = yield* providers
        .fetch(target.mode, {
          url: target.url,
          country:
            target.mode === "advance" && target.country !== null
              ? Option.some(target.country)
              : Option.none(),
        })
        .pipe(Effect.timeout(deadline))

      const bounded = capText(result.envelope.innerText, cap)

      const envelope = {
        ...result.envelope,
        innerText: bounded.text,
        ipInfo: Option.getOrNull(result.envelope.ipInfo),
        session: Option.getOrNull(result.envelope.session),
      }

      const htmlKey = R2Keys.htmlKey(id)
      const rawKey = R2Keys.rawKey(id)
      yield* bucket.put(htmlKey, result.html, "text/html")
      yield* bucket.put(rawKey, JSON.stringify(envelope), "application/json")

      return FetchOutcome.members[0].make({
        envelope,
        htmlKey,
        rawKey,
        truncated: bounded.truncated,
      }) satisfies FetchOutcome
    }).pipe(
      Effect.catchTag("TimeoutError", () =>
        Effect.succeed<FetchOutcome>(
          FetchOutcome.members[1].make({
            code: "timeout",
            message: "Scrape deadline exceeded",
            retryable: true,
            attempts: 1,
            detail: null,
          }),
        ),
      ),
      Effect.catchTag("ScrapeProviderError", (error) =>
        Effect.succeed<FetchOutcome>(
          FetchOutcome.members[1].make({
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            attempts: error.attempts,
            detail: jsonDetail(error.detail) ? error.detail : null,
          }),
        ),
      ),
    )
  })

  const finish = Effect.fn("ScrapeRunner.finish")(function* (
    id: ScrapeId,
    outcome: FetchOutcome,
  ) {
    return yield* db
      .transaction(() =>
        Effect.gen(function* () {
          const now = yield* DateTime.now

          if (Predicate.isTagged(outcome, "failed")) {
            yield* transition(id, "running", "failed", {
              finishedAt: Option.some(now),
              updatedAt: now,
              errorCode: Option.some(outcome.code),
              errorMessage: Option.some(outcome.message),
              attempts: Option.some(outcome.attempts),
            })

            return { extractionId: null }
          }

          const e = outcome.envelope

          const { row, result } = yield* transition(id, "running", "success", {
            finishedAt: Option.some(now),
            updatedAt: now,
            htmlR2Key: Option.some(outcome.htmlKey),
            rawR2Key: Option.some(outcome.rawKey),
            finalUrl: Option.some(e.finalUrl),
            statusCode: Option.some(e.statusCode),
            responseHeaders: Option.some(e.responseHeaders),
            cookies: Option.some(e.cookies),
            innerText: Option.some(e.innerText),
            userAgent: Option.some(e.userAgent),
            ipInfo: e.ipInfo === null ? Option.none() : Option.some(e.ipInfo),
            type: Option.some(e.type),
            session:
              e.session === null ? Option.none() : Option.some(e.session),
            attempts: Option.some(e.attempts),
          })

          if (result === "already_applied") {
            const initial = yield* ExtractionsRepo.findInitial(id)

            if (Option.isNone(initial))
              return yield* Effect.die(
                new Error(
                  "Successful Scrape is missing its initial Extraction",
                ),
              )

            return { extractionId: initial.value.id }
          }

          const target = yield* requireTarget(parent(row))
          yield* ParentsRepo.markScraped(parent(row), now)

          const extraction = yield* ExtractionsRepo.insert({
            scrapeId: id,
            attempt: 1,
            status: "pending",
            promptKind: parentKind(parent(row)),
            promptSnapshot: target.prompt,
            model,
            createdAt: now,
            updatedAt: now,
          })

          return { extractionId: extraction.id }
        }),
      )
      .pipe(
        Effect.catchTag("TransitionRejected", (error) =>
          Effect.gen(function* () {
            if (Predicate.isTagged(outcome, "fetched"))
              yield* bucket
                .delete([outcome.htmlKey, outcome.rawKey])
                .pipe(
                  Effect.catchTag("StorageError", (error) =>
                    Effect.logError(
                      "Rejected Scrape finish object deletion failed",
                      error,
                    ),
                  ),
                )

            return yield* Effect.fail(error)
          }),
        ),
      )
  }, withDb)

  const startExtraction = Effect.fn("ScrapeRunner.startExtraction")(function* (
    extractionId: ExtractionId,
    scrapeId: ScrapeId,
  ) {
    const row = yield* ScrapesRepo.get(scrapeId)
    yield* executions.start("extraction", [
      {
        id: extractionId,
        traceparent: traceparentOf(scrapeId, row.rootSpanId),
      },
    ])
  }, withDb)

  const fail = Effect.fn("ScrapeRunner.fail")(function* (
    id: ScrapeId,
    code: ScrapeErrorCode,
    message: string,
  ) {
    const row = yield* ScrapesRepo.get(id)

    if (isTerminal(row.status)) return
    const now = yield* DateTime.now
    yield* transition(
      id,
      row.status === "pending" ? "pending" : "running",
      "failed",
      {
        finishedAt: Option.some(now),
        updatedAt: now,
        errorCode: Option.some(code),
        errorMessage: Option.some(message),
      },
    )
  }, withDb)

  return { claim, fetch, finish, startExtraction, fail }
})

export class ScrapeRunner extends Context.Service<
  ScrapeRunner,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Scraping/ScrapeRunner", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
