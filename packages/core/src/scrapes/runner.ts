import { ScrapesErrors } from "./errors"
import { ListingsErrors } from "../listings"
import { PagesErrors } from "../pages"
import { LifecycleErrors } from "./lifecycle/errors"
import { Parents } from "./parents"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Predicate from "effect/Predicate"
import { extractionModel } from "./extractions/language-model"
import { Scrape } from "@app/schema/scrape"
import { ScrapeEnvelope } from "@app/schema/scrape-envelope"
import { ScrapeErrorCode, ScrapeMode } from "@app/schema/scraping-vocabulary"
import { RetailerId, type ExtractionId, type ScrapeId } from "@app/schema/ids"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { ScrapeProviders } from "./providers"
import { Executions, type ExecutionsError } from "../executions"
import { Db } from "@app/db"
import { R2Bucket, type StorageError } from "../storage/r2-bucket"
import * as R2Keys from "./r2-keys"
import { traceparentOf } from "./trace"
import { Transitions } from "./transitions"
import { isTerminal } from "./lifecycle"
import { ExtractionsRepo } from "./extractions/repository"
import { ScrapesRepo } from "./repository"

export { LifecycleErrors } from "./lifecycle/errors"

/** Workflow values contain nulls, never Effect Options. */
export const FetchEnvelope = Schema.Struct({
  ...ScrapeEnvelope.Info.fields,
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
  const end = utf8Boundary(encoded, Math.max(0, cap))

  return {
    text: new TextDecoder().decode(encoded.subarray(0, end)),
    truncated: true,
  }
}

const utf8Boundary = (encoded: Uint8Array, end: number): number =>
  end > 0 && (encoded[end]! & 0xc0) === 0x80
    ? utf8Boundary(encoded, end - 1)
    : end

const jsonDetail = Schema.is(Schema.Json)

export * as ScrapeRunner from "./runner"

export interface Interface {
  readonly claim: (
    id: ScrapeId,
  ) => Effect.Effect<
    FetchTarget,
    | ListingsErrors.NotFound
    | PagesErrors.NotFound
    | LifecycleErrors.TransitionRejected
    | SqlError
  >
  readonly fetch: (
    id: ScrapeId,
    target: FetchTarget,
  ) => Effect.Effect<FetchOutcome, StorageError>
  readonly finish: (
    id: ScrapeId,
    outcome: FetchOutcome,
  ) => Effect.Effect<
    { readonly extractionId: ExtractionId | null },
    | ListingsErrors.NotFound
    | PagesErrors.NotFound
    | LifecycleErrors.TransitionRejected
    | SqlError
  >
  readonly startExtraction: (
    extractionId: ExtractionId,
    scrapeId: ScrapeId,
  ) => Effect.Effect<void, ScrapesErrors.NotFound | SqlError | ExecutionsError>
  readonly fail: (
    id: ScrapeId,
    code: ScrapeErrorCode,
    message: string,
  ) => Effect.Effect<
    void,
    ScrapesErrors.NotFound | LifecycleErrors.TransitionRejected | SqlError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/runner",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db
  const extractionsRepo = yield* ExtractionsRepo.Service
  const parents = yield* Parents.Service
  const scrapesRepo = yield* ScrapesRepo.Service
  const transitions = yield* Transitions.Service
  const providers = yield* ScrapeProviders.Service
  const bucket = yield* R2Bucket.Service
  const executions = yield* Executions.Service

  const deadline = yield* Config.duration("SCRAPE_DEADLINE").pipe(
    Config.withDefault(Duration.seconds(180)),
  )

  const cap = yield* Config.int("INNER_TEXT_CAP_BYTES").pipe(
    Config.withDefault(262144),
  )

  const model = yield* extractionModel

  const claim = Effect.fn("ScrapeRunner.claim")(function* (id: ScrapeId) {
    const now = yield* DateTime.now

    const claimed = yield* transitions.scrape(id, "pending", "running", {
      startedAt: Option.some(now),
      updatedAt: now,
    })

    const target = yield* parents.getTarget(Scrape.parent(claimed.row))

    return {
      url: claimed.row.requestUrl,
      mode: claimed.row.mode,
      country: Option.getOrNull(claimed.row.country),
      retailerId: target.retailerId,
      prompt: target.prompt,
      rootSpanId: claimed.row.rootSpanId,
    }
  })

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

      return {
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- the envelope is raw provider data; `.make` would re-validate it and throw a defect past the error handlers below
        _tag: "fetched",
        envelope,
        htmlKey,
        rawKey,
        truncated: bounded.truncated,
      } satisfies FetchOutcome
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
            yield* transitions.scrape(id, "running", "failed", {
              finishedAt: Option.some(now),
              updatedAt: now,
              errorCode: Option.some(outcome.code),
              errorMessage: Option.some(outcome.message),
              attempts: Option.some(outcome.attempts),
            })

            return { extractionId: null }
          }

          const e = outcome.envelope

          const finished = yield* transitions.scrape(id, "running", "success", {
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

          if (finished.result === "already_applied") {
            const initial = yield* extractionsRepo.findInitial(id)

            if (Option.isNone(initial))
              return yield* Effect.die(
                new Error(
                  "Successful Scrape is missing its initial Extraction",
                ),
              )

            return { extractionId: initial.value.id }
          }

          const target = yield* parents.getTarget(Scrape.parent(finished.row))
          yield* parents.markScraped(Scrape.parent(finished.row), now)

          const extraction = yield* extractionsRepo.insert({
            scrapeId: id,
            attempt: 1,
            status: "pending",
            promptKind: Scrape.parentKind(Scrape.parent(finished.row)),
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
  })

  const startExtraction = Effect.fn("ScrapeRunner.startExtraction")(function* (
    extractionId: ExtractionId,
    scrapeId: ScrapeId,
  ) {
    const row = yield* scrapesRepo
      .get(scrapeId)
      .pipe(
        Effect.catchTag("MissingScrape", (error) =>
          Effect.fail(new ScrapesErrors.NotFound({ scrapeId: error.scrapeId })),
        ),
      )

    yield* executions.start({
      kind: "extraction",
      instances: [
        {
          id: extractionId,
          traceparent: traceparentOf(scrapeId, row.rootSpanId),
        },
      ],
    })
  })

  const fail = Effect.fn("ScrapeRunner.fail")(function* (
    id: ScrapeId,
    code: ScrapeErrorCode,
    message: string,
  ) {
    const row = yield* scrapesRepo
      .get(id)
      .pipe(
        Effect.catchTag("MissingScrape", (error) =>
          Effect.fail(new ScrapesErrors.NotFound({ scrapeId: error.scrapeId })),
        ),
      )

    if (isTerminal(row.status)) return
    const now = yield* DateTime.now
    yield* transitions.scrape(
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
  })

  return { claim, fetch, finish, startExtraction, fail }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([
    ExtractionsRepo.layer,
    Parents.layer,
    ScrapesRepo.layer,
    Transitions.layer,
  ]),
)
