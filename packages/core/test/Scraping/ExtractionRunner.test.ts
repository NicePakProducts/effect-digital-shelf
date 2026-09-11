import * as Predicate from "effect/Predicate"
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { expect, it } from "@effect/vitest"
import {
  ExtractionRunner,
  ExtractOutcome,
  ExtractTarget,
} from "@digital-shelf/core/Scraping/ExtractionRunner"
import * as Repo from "@digital-shelf/core/Scraping/repositories/ExtractionsRepo"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import { retailers } from "@digital-shelf/domain/Sql/Catalog"
import { eq } from "drizzle-orm"
import * as ConfigProvider from "effect/ConfigProvider"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as AiError from "effect/unstable/ai/AiError"
import * as CoreTest from "../layers/Core.ts"
import { LanguageModelTest } from "../layers/LanguageModel.ts"
import { R2BucketTest } from "../layers/R2Bucket.ts"
import {
  reset,
  seed,
  successfulScrape,
  extraction,
} from "../fixtures/Scraping.ts"

const stringify = Schema.encodeSync(Schema.fromJsonString(Schema.Json))

const parse = Schema.decodeSync(Schema.fromJsonString(Schema.Json))

const aiError = (reason: AiError.AiErrorReason) =>
  new AiError.AiError({ module: "test", method: "generateText", reason })

const setup = Effect.gen(function* () {
  yield* reset
  const catalog = yield* seed()

  const scrape = yield* successfulScrape((yield* catalog.listing).parent, {
    html: '<p class="x">Hello</p><script>bad()</script>',
  })

  const row = yield* extraction(scrape.id, 1, "pending", {
    prompt: "Snapshot",
    model: "snapshot-model",
  })

  return {
    catalog,
    scrape,
    row,
    runner: yield* ExtractionRunner,
    fake: yield* LanguageModelTest,
  }
})

const configured = (config: Record<string, number>) =>
  ExtractionRunner.make.pipe(
    Effect.provide(ConfigProvider.layerAdd(ConfigProvider.fromUnknown(config))),
  )

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "ExtractionRunner",
  (it) => {
    it.effect(
      "claim uses snapshots and replays without changing start time; extract and finish store JSON-safe data and usage",
      () =>
        Effect.gen(function* () {
          const { catalog, row, runner, fake } = yield* setup
          yield* query(
            (yield* Db)
              .update(retailers)
              .set({ listingExtractPrompt: "Changed after creation" })
              .where(eq(retailers.id, catalog.retailerId)),
          )
          const target = yield* runner.claim(row.id)
          expect(target).toMatchObject({
            prompt: "Snapshot",
            model: "snapshot-model",
          })
          expect(Schema.is(ExtractTarget)(parse(stringify(target)))).toBe(true)
          const started = (yield* Repo.get(row.id)).startedAt
          yield* TestClock.adjust("1 second")
          expect(yield* runner.claim(row.id)).toEqual(target)
          expect((yield* Repo.get(row.id)).startedAt).toEqual(started)
          const outcome = yield* runner.extract(row.id, target)
          expect(Schema.is(ExtractOutcome)(parse(stringify(outcome)))).toBe(
            true,
          )
          expect(yield* fake.calls).toEqual([
            { system: "Snapshot", user: "<p>Hello</p>", maxOutputTokens: 8192 },
          ])
          yield* runner.finish(row.id, outcome)
          const saved = yield* Repo.get(row.id)
          expect(saved).toMatchObject({
            status: "success",
            extractedJson: Option.some({ title: "Hello" }),
            promptTokens: Option.some(10),
            completionTokens: Option.some(5),
            totalTokens: Option.some(15),
            finishedAt: Option.some(yield* DateTime.now),
          })
          yield* TestClock.adjust("1 second")
          yield* runner.finish(row.id, outcome)
          expect(yield* Repo.get(row.id)).toEqual(saved)
          yield* runner.fail(row.id, "unknown", "late failure")
          expect(yield* Repo.get(row.id)).toEqual(saved)
        }),
    )
    it.effect(
      "empty and length replies fail JSON mode; one repair accepts an object and rejects invalid roots",
      () =>
        Effect.gen(function* () {
          const { row, runner, fake } = yield* setup
          const target = yield* runner.claim(row.id)

          for (const [text, finishReason, code] of [
            ['{"ok":true}', "length", "json_mode_unmet"],
            ["", "stop", "json_mode_unmet"],
            ["not json at all", "stop", "invalid_json"],
            ["[1,2]", "stop", "invalid_json"],
            ['"str"', "stop", "invalid_json"],
            ["null", "stop", "invalid_json"],
          ] as const) {
            yield* fake.answer(text, { finishReason })
            expect(yield* runner.extract(row.id, target)).toMatchObject({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
              _tag: "failed",
              code,
            })
          }

          yield* fake.answer('{"a":1,', { usage: { input: 7, output: 3 } })
          expect(yield* runner.extract(row.id, target)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "extracted",
            data: { a: 1 },
            usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
          })
        }),
    )
    it.effect(
      "default retry count makes one call and context rejection maps separately",
      () =>
        Effect.gen(function* () {
          const { row, runner, fake } = yield* setup
          const target = yield* runner.claim(row.id)
          yield* fake.fail(aiError(new AiError.RateLimitError({})))
          expect(yield* runner.extract(row.id, target)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "failed",
            code: "provider_error",
          })
          expect(yield* fake.calls).toHaveLength(1)
          yield* fake.fail(
            aiError(
              new AiError.InvalidRequestError({
                description: "maximum context length exceeded: 5021",
              }),
            ),
          )
          expect(yield* runner.extract(row.id, target)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "failed",
            code: "context_overflow",
          })
        }),
    )
    it.effect(
      "configured retries honour retryAfter and recover from retryable errors",
      () =>
        Effect.gen(function* () {
          const { row, fake } = yield* setup
          const runner = yield* configured({ EXTRACTION_RETRIES: 1 })
          const target = yield* runner.claim(row.id)
          yield* fake.fail(
            aiError(
              new AiError.RateLimitError({ retryAfter: Duration.seconds(5) }),
            ),
          )
          yield* fake.answer('{"retry":true}')

          const fiber = yield* runner
            .extract(row.id, target)
            .pipe(Effect.forkChild)

          yield* TestClock.adjust("4 seconds")
          expect(yield* fake.calls).toHaveLength(1)
          yield* TestClock.adjust("1 second")
          expect(yield* Fiber.join(fiber)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "extracted",
            data: { retry: true },
          })
          expect(yield* fake.calls).toHaveLength(2)
        }),
    )
    it.effect("input cap fails without a model call and never truncates", () =>
      Effect.gen(function* () {
        const { row, fake } = yield* setup
        const runner = yield* configured({ EXTRACTION_INPUT_CAP_BYTES: 3 })
        expect(
          yield* runner.extract(row.id, yield* runner.claim(row.id)),
        ).toEqual(
          ExtractOutcome.members[1].make({
            code: "context_overflow",
            message: "Sanitised input of 12 bytes exceeds the cap of 3 bytes",
          }),
        )
        expect(yield* fake.calls).toHaveLength(0)
      }),
    )
    it.effect(
      "one TestClock deadline bounds the model call and retry backoff",
      () =>
        Effect.gen(function* () {
          const { row, runner, fake } = yield* setup
          const target = yield* runner.claim(row.id)
          yield* fake.delay("10 minutes")

          const fiber = yield* runner
            .extract(row.id, target)
            .pipe(Effect.forkChild)

          yield* TestClock.adjust("121 seconds")
          expect(yield* Fiber.join(fiber)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "failed",
            code: "llm_timeout",
          })
          const retrying = yield* configured({ EXTRACTION_RETRIES: 1 })
          yield* fake.fail(
            aiError(
              new AiError.RateLimitError({ retryAfter: Duration.minutes(10) }),
            ),
          )

          const retried = yield* retrying
            .extract(row.id, target)
            .pipe(Effect.forkChild)

          yield* TestClock.adjust("121 seconds")
          expect(yield* Fiber.join(retried)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "failed",
            code: "llm_timeout",
          })
          expect(yield* fake.calls).toHaveLength(2)
        }),
    )
    it.effect(
      "missing storage produces unknown and a replay-safe failed finish",
      () =>
        Effect.gen(function* () {
          const { row, runner } = yield* setup
          const target = yield* runner.claim(row.id)
          yield* (yield* R2BucketTest).service.delete([target.htmlKey])
          const outcome = yield* runner.extract(row.id, target)
          expect(outcome).toEqual(
            ExtractOutcome.members[1].make({
              code: "unknown",
              message: "Scrape HTML object missing from storage",
            }),
          )
          yield* runner.finish(row.id, outcome)
          const saved = yield* Repo.get(row.id)
          expect(saved).toMatchObject({
            status: "failed",
            errorCode: Option.some("unknown"),
            errorMessage: Option.some(
              "Scrape HTML object missing from storage",
            ),
          })
          yield* runner.finish(row.id, outcome)
          expect(yield* Repo.get(row.id)).toEqual(saved)
        }),
    )
    it.effect(
      "compensation fails pending and a late successful finish cannot resurrect swept rows",
      () =>
        Effect.gen(function* () {
          const { row, runner, scrape } = yield* setup
          yield* runner.fail(row.id, "unknown", "before claim")
          expect((yield* Repo.get(row.id)).status).toBe("failed")
          const next = yield* extraction(scrape.id, 2, "pending")

          const outcome = yield* runner.extract(
            next.id,
            yield* runner.claim(next.id),
          )

          yield* runner.fail(next.id, "llm_timeout", "swept")
          expect(
            yield* Effect.flip(runner.finish(next.id, outcome)),
          ).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "TransitionRejected",
            kind: "extraction",
            observed: "failed",
          })
        }),
    )
    it.effect(
      "real compat requests use snapshot model, JSON mode, output budget and gateway trace headers",
      () =>
        Effect.gen(function* () {
          const { row } = yield* setup
          const requests: HttpClientRequest.HttpClientRequest[] = []

          const http = HttpClient.make((request) =>
            Effect.sync(() => {
              requests.push(request)

              return HttpClientResponse.fromWeb(
                request,
                new Response(
                  stringify({
                    id: "chatcmpl_test",
                    object: "chat.completion",
                    model: "snapshot-model",
                    created: 1,
                    choices: [
                      {
                        index: 0,
                        finish_reason: "stop",
                        message: { role: "assistant", content: '{"ok":true}' },
                      },
                    ],
                    usage: {
                      prompt_tokens: 12,
                      completion_tokens: 6,
                      total_tokens: 18,
                    },
                  }),
                  { headers: { "content-type": "application/json" } },
                ),
              )
            }),
          )

          const model = OpenAiLanguageModel.layer({
            model: "changed-global-model",
            config: { chat_template_kwargs: { enable_thinking: false } },
          }).pipe(
            Layer.provide(
              OpenAiClient.layer({ apiUrl: "https://example.com/v1" }).pipe(
                Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
              ),
            ),
          )

          const runner = yield* ExtractionRunner.make.pipe(
            Effect.provide(model),
          )

          const target = yield* runner.claim(row.id)
          expect(yield* runner.extract(row.id, target)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "extracted",
            data: { ok: true },
            usage: { promptTokens: 12, completionTokens: 6, totalTokens: 18 },
          })
          const request = requests[0]!
          expect(request.url).toBe("https://example.com/v1/chat/completions")
          expect(request.headers["cf-aig-otel-trace-id"]).toBe(
            target.scrapeId.replaceAll("-", ""),
          )
          expect(request.headers["cf-aig-otel-parent-span-id"]).toMatch(
            /^[0-9a-f]{16}$/,
          )
          expect(parse(request.headers["cf-aig-metadata"]!)).toEqual({
            extractionId: row.id,
            scrapeId: target.scrapeId,
            gatewayId: "digital-shelf-ai-gateway-dev",
          })
          expect(request.body._tag).toBe("Uint8Array")

          if (Predicate.isTagged(request.body, "Uint8Array"))
            expect(
              parse(new TextDecoder().decode(request.body.body)),
            ).toMatchObject({
              model: "snapshot-model",
              response_format: { type: "json_object" },
              max_tokens: 8192,
              chat_template_kwargs: { enable_thinking: false },
              messages: [
                { role: "system", content: "Snapshot" },
                { role: "user", content: "<p>Hello</p>" },
              ],
            })
          yield* runner
            .extract(row.id, target)
            .pipe(Effect.withTracerEnabled(false))
          expect(requests[1]?.headers["cf-aig-otel-trace-id"]).toBeUndefined()
          expect(
            requests[1]?.headers["cf-aig-otel-parent-span-id"],
          ).toBeUndefined()
        }),
    )

    it.effect(
      "context_id validation is a provider error, while Cloudflare context-window rejection is overflow",
      () =>
        Effect.gen(function* () {
          const { row, runner, fake } = yield* setup
          const target = yield* runner.claim(row.id)

          for (const [description, code] of [
            ["invalid parameter context_id", "provider_error"],
            [
              "5021: request exceeded this model context window limit",
              "context_overflow",
            ],
          ] as const) {
            yield* fake.fail(
              aiError(new AiError.InvalidRequestError({ description })),
            )
            expect(yield* runner.extract(row.id, target)).toMatchObject({
              // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
              _tag: "failed",
              code,
            })
          }
        }),
    )
    it.effect(
      "non-retryable authentication errors make one call even with two configured retries",
      () =>
        Effect.gen(function* () {
          const { row, fake } = yield* setup
          const runner = yield* configured({ EXTRACTION_RETRIES: 2 })
          yield* fake.fail(
            aiError(new AiError.AuthenticationError({ kind: "InvalidKey" })),
          )
          expect(
            yield* runner.extract(row.id, yield* runner.claim(row.id)),
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
          ).toMatchObject({ _tag: "failed", code: "provider_error" })
          expect(yield* fake.calls).toHaveLength(1)
        }),
    )
  },
)
