import * as Option from "effect/Option"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type * as AiError from "effect/unstable/ai/AiError"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as Response from "effect/unstable/ai/Response"

const parts = (
  text: string,
  options: {
    finishReason?: Response.FinishReason
    usage?: { input: number; output: number }
  } = {},
): Array<Response.PartEncoded> => [
  { type: "text", text },
  {
    type: "finish",
    reason: options.finishReason ?? "stop",
    usage: {
      inputTokens: { total: options.usage?.input ?? 10 },
      outputTokens: { total: options.usage?.output ?? 5 },
    },
  },
]
const make = Effect.gen(function* () {
  const calls = yield* Ref.make<
    ReadonlyArray<{ system: string; user: string; maxOutputTokens?: number }>
  >([])
  const scripts = yield* Ref.make<
    ReadonlyArray<Effect.Effect<Array<Response.PartEncoded>, AiError.AiError>>
  >([])
  const script = (
    effect: Effect.Effect<Array<Response.PartEncoded>, AiError.AiError>,
  ) => Ref.update(scripts, (values) => [...values, effect])
  const service = yield* LanguageModel.make({
    generateText: (options) =>
      Effect.gen(function* () {
        const config = yield* Effect.serviceOption(
          OpenAiLanguageModel.Config,
        ).pipe(Effect.map(Option.getOrUndefined))
        const system = options.prompt.content
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n")
        const user = options.prompt.content
          .filter((message) => message.role === "user")
          .flatMap((message) => message.content)
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
        yield* Ref.update(calls, (calls) => [
          ...calls,
          {
            system,
            user,
            ...(config?.max_output_tokens == null
              ? {}
              : { maxOutputTokens: config.max_output_tokens }),
          },
        ])
        const next = yield* Ref.modify(scripts, (scripts) => [
          scripts[0],
          scripts.slice(1),
        ])
        return yield* next ?? Effect.succeed(parts('{"title":"Hello"}'))
      }),
    streamText: () => Stream.die("not scripted"),
  })
  return {
    service,
    script,
    calls: Ref.get(calls),
    answer: (text: string, options?: Parameters<typeof parts>[1]) =>
      script(Effect.succeed(parts(text, options))),
    fail: (error: AiError.AiError) => script(Effect.fail(error)),
    delay: (duration: Duration.Input) =>
      script(
        Effect.sleep(duration).pipe(Effect.as(parts('{"title":"Hello"}'))),
      ),
    reset: Effect.gen(function* () {
      yield* Ref.set(calls, [])
      yield* Ref.set(scripts, [])
    }),
  }
})
export class LanguageModelTest extends Context.Service<
  LanguageModelTest,
  Effect.Success<typeof make>
>()("test/LanguageModel", { make }) {}
export const layerTest = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.map(LanguageModelTest, (test) => test.service),
).pipe(
  Layer.provideMerge(Layer.effect(LanguageModelTest, LanguageModelTest.make)),
)
