import * as Tracer from "effect/Tracer"
import * as Schedule from "effect/Schedule"
import type * as AiError from "effect/unstable/ai/AiError"
import {
  ExtractionErrorCode,
  PromptKind,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import { ScrapeId, type ExtractionId } from "@digital-shelf/domain/Shared/Ids"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import { completeJson } from "../Providers/LanguageModel.ts"
import { Executions } from "../Scheduling/Executions.ts"
import { Db } from "../Sql/Db.ts"
import { R2Bucket } from "../Storage/R2Bucket.ts"
import { classifyExtractionError, parseExtractedJson } from "./ExtractedJson.ts"
import { sanitise } from "./Sanitise.ts"
import { traceIdOf } from "./Trace.ts"
import { isTerminal, transitionExtraction } from "./Transitions.ts"
import * as ExtractionsRepo from "./repositories/ExtractionsRepo.ts"
import * as ScrapesRepo from "./repositories/ScrapesRepo.ts"

export const ExtractTarget = Schema.Struct({
  scrapeId: ScrapeId,
  htmlKey: Schema.String,
  prompt: Schema.String,
  promptKind: PromptKind,
  model: Schema.String,
  rootSpanId: Schema.String,
})
export type ExtractTarget = typeof ExtractTarget.Type
export const ExtractOutcome = Schema.Union([
  Schema.TaggedStruct("extracted", {
    data: Schema.Json,
    usage: Schema.Struct({
      promptTokens: Schema.Int,
      completionTokens: Schema.Int,
      totalTokens: Schema.Int,
    }),
    finishReason: Schema.String,
  }),
  Schema.TaggedStruct("failed", {
    code: ExtractionErrorCode,
    message: Schema.String,
  }),
])
export type ExtractOutcome = typeof ExtractOutcome.Type
const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const bucket = yield* R2Bucket
  const model = yield* LanguageModel.LanguageModel
  yield* Executions
  const deadline = yield* Config.duration("EXTRACTION_DEADLINE").pipe(
    Config.withDefault(Duration.seconds(120)),
    Effect.orDie,
  )
  const retries = yield* Config.int("EXTRACTION_RETRIES").pipe(
    Config.withDefault(0),
    Effect.orDie,
  )
  const cap = yield* Config.int("EXTRACTION_INPUT_CAP_BYTES").pipe(
    Config.withDefault(300000),
    Effect.orDie,
  )
  const maxOutputTokens = yield* Config.int(
    "EXTRACTION_MAX_OUTPUT_TOKENS",
  ).pipe(Config.withDefault(8192), Effect.orDie)
  const claim = Effect.fn("ExtractionRunner.claim")(function* (
    id: ExtractionId,
  ) {
    const now = yield* DateTime.now
    const { row } = yield* transitionExtraction(id, "pending", "running", {
      startedAt: Option.some(now),
      updatedAt: now,
    })
    const scrape = yield* ScrapesRepo.get(row.scrapeId)
    return {
      scrapeId: scrape.id,
      htmlKey: Option.getOrElse(scrape.htmlR2Key, () => ""),
      prompt: row.promptSnapshot,
      promptKind: row.promptKind,
      model: row.model,
      rootSpanId: scrape.rootSpanId,
    }
  }, withDb)
  const extract = Effect.fn("ExtractionRunner.extract")(function* (
    id: ExtractionId,
    target: ExtractTarget,
  ) {
    return yield* Effect.gen(function* (): Effect.fn.Return<
      ExtractOutcome,
      unknown
    > {
      const html = yield* bucket.get(target.htmlKey)
      if (Option.isNone(html))
        return {
          _tag: "failed",
          code: "unknown",
          message: "Scrape HTML object missing from storage",
        }
      const user = sanitise(html.value)
      const bytes = new TextEncoder().encode(user).length
      if (bytes > cap)
        return {
          _tag: "failed",
          code: "context_overflow",
          message: `Sanitised input of ${bytes} bytes exceeds the cap of ${cap} bytes`,
        }
      const response = yield* Effect.gen(function* () {
        const span = yield* Effect.currentSpan.pipe(Effect.option)
        const headers: Record<string, string> = {
          "cf-aig-metadata": yield* Schema.encodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                extractionId: Schema.String,
                scrapeId: ScrapeId,
              }),
            ),
          )({ extractionId: id, scrapeId: target.scrapeId }).pipe(Effect.orDie),
        }
        if (Option.isSome(span) && span.value.spanId !== "noop") {
          headers["cf-aig-otel-trace-id"] = traceIdOf(target.scrapeId)
          headers["cf-aig-otel-parent-span-id"] = span.value.spanId
        }
        yield* Effect.annotateCurrentSpan({
          "gen_ai.request.model": target.model,
          "shelf.extraction.id": id,
          "shelf.scrape.id": target.scrapeId,
        })
        const call = completeJson({
          system: target.prompt,
          user,
          maxOutputTokens,
          headers,
          model: target.model,
        }).pipe(Effect.provideService(LanguageModel.LanguageModel, model))
        const retrying = call.pipe(
          Effect.retry(
            Schedule.recurs(retries).pipe(
              Schedule.while(
                ({ input }: Schedule.Metadata<number, AiError.AiError>) =>
                  input.isRetryable,
              ),
              Schedule.addDelay(({ input }) =>
                Effect.succeed(input.retryAfter ?? Duration.zero),
              ),
            ),
          ),
        )
        const response = yield* retrying.pipe(Effect.timeout(deadline))
        yield* Effect.annotateCurrentSpan({
          "gen_ai.usage.input_tokens": response.usage.input,
          "gen_ai.usage.output_tokens": response.usage.output,
        })
        return response
      }).pipe(Effect.withSpan("Extraction.llm"))
      const parsed = parseExtractedJson(response.text, response.finishReason)
      if (parsed._tag === "failed") return parsed
      return {
        _tag: "extracted",
        data: parsed.value,
        finishReason: response.finishReason,
        usage: {
          promptTokens: response.usage.input,
          completionTokens: response.usage.output,
          totalTokens: response.usage.input + response.usage.output,
        },
      }
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed<ExtractOutcome>({
          _tag: "failed",
          ...classifyExtractionError(error),
        }),
      ),
      Effect.catchDefect((error) =>
        Effect.succeed<ExtractOutcome>({
          _tag: "failed",
          ...classifyExtractionError(error),
        }),
      ),
    )
  })
  const finish = Effect.fn("ExtractionRunner.finish")(function* (
    id: ExtractionId,
    outcome: ExtractOutcome,
  ) {
    yield* db.transaction(() =>
      Effect.gen(function* () {
        const now = yield* DateTime.now
        yield* transitionExtraction(
          id,
          "running",
          outcome._tag === "extracted" ? "success" : "failed",
          {
            finishedAt: Option.some(now),
            updatedAt: now,
            ...(outcome._tag === "extracted"
              ? {
                  extractedJson: Option.some(outcome.data),
                  promptTokens: Option.some(outcome.usage.promptTokens),
                  completionTokens: Option.some(outcome.usage.completionTokens),
                  totalTokens: Option.some(outcome.usage.totalTokens),
                }
              : {
                  errorCode: Option.some(outcome.code),
                  errorMessage: Option.some(outcome.message),
                }),
          },
        )
      }),
    )
  }, withDb)
  const fail = Effect.fn("ExtractionRunner.fail")(function* (
    id: ExtractionId,
    code: ExtractionErrorCode,
    message: string,
  ) {
    const row = yield* ExtractionsRepo.get(id)
    if (isTerminal(row.status)) return
    const now = yield* DateTime.now
    yield* transitionExtraction(
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
  const underScrape = <A, E, R>(
    id: ExtractionId,
    target: { scrapeId: ScrapeId; rootSpanId: string },
    work: Effect.Effect<A, E, R>,
  ) =>
    work.pipe(
      Effect.withParentSpan(
        Tracer.externalSpan({
          traceId: traceIdOf(target.scrapeId),
          spanId: target.rootSpanId,
        }),
      ),
      Effect.annotateSpans({
        "shelf.extraction.id": id,
        "shelf.scrape.id": target.scrapeId,
      }),
    )
  const withRowTrace = <A, E, R>(
    id: ExtractionId,
    work: Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const row = yield* ExtractionsRepo.get(id)
      const scrape = yield* ScrapesRepo.get(row.scrapeId)
      return yield* underScrape(
        id,
        { scrapeId: scrape.id, rootSpanId: scrape.rootSpanId },
        work,
      ).pipe(Effect.annotateSpans({ "shelf.attempt": row.attempt }))
    }).pipe(withDb)
  return {
    claim: (id: ExtractionId) => withRowTrace(id, claim(id)),
    extract: (id: ExtractionId, target: ExtractTarget) =>
      underScrape(id, target, extract(id, target)),
    finish: (id: ExtractionId, outcome: ExtractOutcome) =>
      withRowTrace(id, finish(id, outcome)),
    fail: (id: ExtractionId, code: ExtractionErrorCode, message: string) =>
      withRowTrace(id, fail(id, code, message)),
  }
})
export class ExtractionRunner extends Context.Service<
  ExtractionRunner,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Scraping/ExtractionRunner", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
