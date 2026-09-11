import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiConfig from "@effect/ai-openai-compat/OpenAiConfig"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

export const extractionModel = Config.string("EXTRACTION_MODEL").pipe(
  Config.withDefault("@cf/zai-org/glm-4.7-flash"),
)

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* Config.string("AI_GATEWAY_ID")
    const model = yield* extractionModel

    const client = OpenAiClient.layerConfig({
      apiKey: Config.redacted("AI_GATEWAY_TOKEN"),
      apiUrl: Config.string("AI_GATEWAY_ACCOUNT_ID").pipe(
        Config.map(
          (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1`,
        ),
      ),
      transformClient: HttpClient.mapRequest(
        HttpClientRequest.setHeader("cf-aig-gateway-id", gateway),
      ),
    }).pipe(Layer.provide(FetchHttpClient.layer))

    return OpenAiLanguageModel.layer({
      model,
      config: { chat_template_kwargs: { enable_thinking: false } },
    }).pipe(Layer.provide(client))
  }),
)

/** Model override preserves the row's snapshot across a configuration change. */
export const completeJson = (request: {
  system: string
  user: string
  maxOutputTokens: number
  headers: Record<string, string>
  model?: string
}) => {
  const config = {
    response_format: { type: "json_object" as const },
    max_output_tokens: request.maxOutputTokens,
  }

  return LanguageModel.generateText({
    prompt: [
      { role: "system", content: request.system },
      { role: "user", content: request.user },
    ],
  }).pipe(
    OpenAiLanguageModel.withConfigOverride(
      request.model === undefined
        ? config
        : { ...config, model: request.model },
    ),
    OpenAiConfig.withClientTransform(
      HttpClient.mapRequest(HttpClientRequest.setHeaders(request.headers)),
    ),
    Effect.map((response) => ({
      text: response.text,
      finishReason: response.finishReason,
      usage: {
        input: response.usage.inputTokens.total ?? 0,
        output: response.usage.outputTokens.total ?? 0,
      },
    })),
  )
}
