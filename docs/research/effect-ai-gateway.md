# Effect AI on the RC against Cloudflare AI Gateway

Research for [wayfinder ticket #6](https://github.com/NicePakProducts/effect-digital-shelf/issues/6) (part of map #1). Written 2026-09-08.

**Question.** Using `effect/unstable/ai` and `@effect/ai-openai` at rc.112, how do we call an OpenAI-compatible endpoint hosted by Cloudflare AI Gateway or Workers AI, request JSON-mode structured output, capture prompt and completion token usage, and apply a deadline? Confirm the pinned model `@cf/zai-org/glm-4.7-flash` is reachable that way. Report the client layer shape and any RC API differences from v3.

## TL;DR

1. **Use `@effect/ai-openai-compat`, not `@effect/ai-openai`.** At rc.112 `@effect/ai-openai` only speaks the OpenAI *Responses* API (`POST /responses`); the sibling package `@effect/ai-openai-compat` (same version, same module names) speaks *chat completions* (`POST /chat/completions`), which is what Cloudflare exposes for Workers AI models. slopcop uses `@effect/ai-openai` because it talks to real OpenAI; that choice does not carry over.
2. **Point `apiUrl` at the AI Gateway REST API**, `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`, with a Cloudflare API token as the bearer and a `cf-aig-gateway-id` header. Cloudflare now marks the older `gateway.ai.cloudflare.com/.../compat` endpoint deprecated for single-model calls.
3. **Structured output.** `LanguageModel.generateObject` always sends `response_format: { type: "json_schema", strict: true }` derived from your Effect Schema and decodes the reply through that same schema. Plain JSON mode (`json_object`, the old app's contract) is available by passing `response_format` through the model `config` and decoding `generateText(...).text` yourself.
4. **Usage** comes back on the response as `response.usage.inputTokens.total` / `outputTokens.total` (mapped from `prompt_tokens` / `completion_tokens`).
5. **Deadline** is `Effect.timeout("60 seconds")`, which fails with `Cause.TimeoutError` and interrupts the HTTP call. Provider failures arrive as one `AiError` whose `reason._tag` is a closed union; map both into your own tagged error union with `Effect.catchTags`.
6. **Reachability confirmed live** (2026-09-08): `@cf/zai-org/glm-4.7-flash` answered HTTP 200 on the REST path with both `json_object` and strict `json_schema`. Caveat: it is a reasoning model and, with thinking enabled, can spend the whole output budget on `reasoning_content` and return `content: null`. Send `chat_template_kwargs: { enable_thinking: false }` for extraction.

## Sources

Local (primary source code):

- Effect v4 RC checkout at `.repos/effect` (`effect@4.0.0-rc.112`, `@effect/ai-openai@4.0.0-rc.112`, `@effect/ai-openai-compat@4.0.0-rc.112` per each `package.json`). Files cited below by path under `packages/`.
- slopcop's usage: `.repos/slopcop/packages/labeling/src/Ai.ts` and `PolicyAi.ts`.
- Old app parity: `browser-worker/backend/src/extract/workflow.ts`, `browser-worker/core/src/extract/defaults.ts`, `browser-worker/core/src/extract/extract.ts`.
- v3 for comparison: `@effect/ai-openai@0.41.0` and `@effect/ai@0.37.0` `dist/dts` and `dist/esm` fetched from unpkg (latest `<1` versions per `npm view`).

Remote (Cloudflare docs, fetched as Markdown via `.../index.md` on 2026-09-08):

- [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) (page dated Aug 12, 2026)
- [AI Gateway get started](https://developers.cloudflare.com/ai-gateway/get-started/)
- [AI Gateway Unified API (OpenAI compat)](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/) (Aug 7, 2026)
- [AI Gateway provider: Workers AI](https://developers.cloudflare.com/ai-gateway/usage/providers/workersai/) (Aug 7, 2026)
- [Workers AI OpenAI compatible API endpoints](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/) (Apr 21, 2026)
- [Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/) (Apr 21, 2026)
- [Model page: glm-4.7-flash](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/)

Live probes were run with `curl` against the REST API using the local `wrangler auth token` (see section 5).

## 1. Which Effect package talks chat completions

`@effect/ai-openai`'s client posts to `/responses` and decodes `OpenAiSchema.Response`:

- `packages/ai/openai/src/OpenAiClient.ts`: `client.execute(HttpClientRequest.post("/responses", { body: HttpBody.jsonUnsafe(payload) }))` inside `createResponse`; the module doc says it is "used by the OpenAI integration for Responses API and embedding requests".

`@effect/ai-openai-compat` is the chat-completions adapter:

- `packages/ai/openai-compat/src/OpenAiClient.ts`: module doc "Effect service for OpenAI-compatible chat completions and embeddings APIs"; `createResponse` and `createResponseStream` both do `HttpClientRequest.post("/chat/completions")` (lines 185 and 231), embeddings post `/embeddings` (line 257).
- `packages/ai/openai-compat/src/OpenAiLanguageModel.ts`: module doc "adapts OpenAI-compatible chat completions providers to Effect AI's `LanguageModel` service"; `toChatCompletionsRequest` converts the internal Responses-shaped request into `{ model, messages, temperature, top_p, max_tokens, ..., response_format, tools, tool_choice }`.
- `packages/ai/openai-compat/README.md`: "Connects the Effect AI modules to any OpenAI-compatible API, with support for chat completions and embeddings." Install: `npm install effect@rc @effect/ai-openai-compat@rc`.

Cloudflare's side only offers chat completions for Workers AI models in general: the REST API endpoint table lists `POST /ai/v1/chat/completions` as "Workers AI Models (@cf/): Yes" but `POST /ai/v1/responses` as "Model dependent", with the note to "Use `/ai/run` or `/ai/v1/chat/completions` for Workers AI models, or `/ai/v1/responses` only for Workers AI models that support the Responses API, such as GPT-OSS" ([REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/) "Endpoints"). The glm-4.7-flash model page documents only `/v1/chat/completions` and `/v1/embeddings` as its OpenAI-compatible endpoints.

Both packages export the same module names (`OpenAiClient`, `OpenAiConfig`, `OpenAiLanguageModel`, `OpenAiError`, ...) with the same `layer` / `layerConfig` / `model` / `withConfigOverride` shapes, so slopcop's `Ai.ts` layer pattern ports over with only the import path changed (`packages/ai/openai-compat/src/index.ts`).

## 2. Which Cloudflare URL and which headers

Three OpenAI-compatible base URLs exist; the docs currently steer to the first.

| Base URL for `apiUrl` | Model id | Auth | Status |
| --- | --- | --- | --- |
| `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1` | `@cf/zai-org/glm-4.7-flash` | `Authorization: Bearer <CF API token>` plus header `cf-aig-gateway-id: <gateway>` | Documented; **verified live HTTP 200** |
| `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/compat` | `workers-ai/@cf/zai-org/glm-4.7-flash` | `Authorization: Bearer <CF API token>` (plus `cf-aig-authorization` if the gateway is authenticated) | Docs: "Deprecated for single-model calls ... will continue to work for existing integrations"; my probe with the wrangler OAuth token got 401 (unverified with a real API token) |
| `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/workers-ai/v1` | `@cf/zai-org/glm-4.7-flash` | as above | No longer shown on the Workers AI provider page (it now documents only the REST API and the Worker binding); probe got 401 with the OAuth token (unverified) |

Evidence:

- REST API page, "Model naming": "Workers AI models use the `@cf/author/model` format ... Workers AI requests also require the `cf-aig-gateway-id` header." "Specify a gateway": "By default, third-party model requests route through your account's default AI Gateway. To use a specific gateway, include the `cf-aig-gateway-id` header. Workers AI requests always require this header."
- REST API page, "Authentication": "Authenticate with a Cloudflare API token that has the **Account > Workers AI > Read** permission. Pass it in the `Authorization` header. ... A token that holds only an `AI Gateway` permission returns `401` with error code `10000`."
- Get started page: create a token "with `AI Gateway - Read`, `AI Gateway - Edit`, and `Workers AI - Read` permissions"; first-request example is exactly `POST .../ai/v1/chat/completions` with `Authorization: Bearer` and `cf-aig-gateway-id: default`.
- Unified API page: "For standard single-model chat completions, this endpoint is deprecated. Use the REST API instead, which provides OpenAI-compatible endpoints at `api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1/chat/completions`."
- Workers AI provider page: the `cf-aig-gateway-id` header "specif[ies] which gateway to route through"; the page's REST example is the same `/ai/v1/chat/completions` URL.
- Workers AI OpenAI-compat page: direct (non-gateway) base URL is `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/ai/v1`. It is the same host and path as the gateway REST API; the only difference is the `cf-aig-gateway-id` header.

So "Workers AI OpenAI-compatible" and "AI Gateway REST API" are the same URL; adding `cf-aig-gateway-id` opts the request into the gateway (logs, cache, rate limits, unified billing).

## 3. Answers with code sketches

All snippets target rc.112 import paths. `effect/unstable/http/*` modules are the RC's HTTP client (slopcop imports them the same way).

### (a) Build the LanguageModel layer against AI Gateway

```ts
import { Config, Effect, Layer, Redacted, Schedule } from "effect"
import { flow } from "effect/Function"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient"
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel"

export const EXTRACT_MODEL = "@cf/zai-org/glm-4.7-flash"

// HttpClient -> OpenAiClient
export const GatewayClientLayer = OpenAiClient.layerConfig({
  apiKey: Config.redacted("CLOUDFLARE_API_TOKEN"),
  apiUrl: Config.string("CLOUDFLARE_ACCOUNT_ID").pipe(
    Config.map((id) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai/v1`)
  ),
  transformClient: flow(
    HttpClient.mapRequest(HttpClientRequest.setHeader("cf-aig-gateway-id", "default")),
    HttpClient.retryTransient({ times: 3, schedule: Schedule.exponential(500) })
  )
}).pipe(Layer.provide(FetchHttpClient.layer))

// OpenAiClient -> LanguageModel
export const ExtractModelLayer = OpenAiLanguageModel.layer({
  model: EXTRACT_MODEL,
  config: {
    max_output_tokens: 4096,                         // sent as `max_tokens`
    chat_template_kwargs: { enable_thinking: false } // unknown keys pass through
  }
})

export const AiLayer = ExtractModelLayer.pipe(Layer.provide(GatewayClientLayer))
```

Why each piece is shaped this way (all from `packages/ai/openai-compat/src/OpenAiClient.ts` unless noted):

- `Options` has `apiKey?: Redacted<string>`, `apiUrl?: string` (default `https://api.openai.com/v1`), `organizationId`, `projectId`, `transformClient`. `make` builds the client as `baseClient.pipe(HttpClient.mapRequest(flow(prependUrl(apiUrl), bearerToken(apiKey), acceptJson)), HttpClient.filterStatusOk, transformClient ?? identity)` (lines 136-150), so `transformClient` runs after the URL and bearer are set and after non-2xx statuses are turned into `StatusCodeError`; a `mapRequest` inside it is the right place for the `cf-aig-gateway-id` header, and `retryTransient` there sees 429/5xx as retryable (same pattern as slopcop `Ai.ts`).
- `layer(options)` returns `Layer<OpenAiClient, never, HttpClient>`; `layerConfig({ apiKey?: Config<Redacted|undefined>, apiUrl?: Config<string>, ... })` returns `Layer<OpenAiClient, ConfigError, HttpClient>` (lines 294-345). The test suite exercises a custom `apiUrl: "https://compat.example.test/v1"` (`test/OpenAiClient.test.ts` line 546).
- `OpenAiLanguageModel.layer({ model, config? })` returns `Layer<LanguageModel, never, OpenAiClient>`; `OpenAiLanguageModel.model(model, config?)` returns an `AiModel.Model<"openai", LanguageModel, OpenAiClient>` for `Effect.provide` (`OpenAiLanguageModel.ts` lines 537-541, 684-689). slopcop uses the `model(...)` form inside `Layer.unwrap` (`Ai.ts`).
- `config` is `ModelConfig = Omit<ConfigOptions, "model"> & { [x: string]: unknown }` (line 105). Known Responses-shaped keys are translated (`max_output_tokens` -> `max_tokens`, `temperature`, `top_p`, `seed`, `user`, `reasoning`, `service_tier`, `parallel_tool_calls`) and any key not in `createResponseKnownProperties` is copied verbatim onto the chat request by `extractCustomRequestProperties` (lines 1553-1611), which is how `chat_template_kwargs` reaches Cloudflare. `fileIdPrefixes` and `strictJsonSchema` are stripped before sending (line 609).
- Per-call overrides: `OpenAiLanguageModel.withConfigOverride(effect, { max_output_tokens: 8192 })` merges over the layer defaults with the override winning (lines 708-730); `OpenAiConfig.withClientTransform` scopes an extra HTTP transform to one effect (`OpenAiConfig.ts`).
- `FetchHttpClient.layer: Layer<HttpClient>` wraps global `fetch` (`packages/effect/src/unstable/http/FetchHttpClient.ts` line 125), which is what a Worker has.

Unknown model ids are treated as non-reasoning "system"-role models: `getModelCapabilities` allow-lists only `o1/o3/o4-mini/codex-mini/gpt-5*` as reasoning models and otherwise sets `systemMessageMode = "system"` (lines 1951-1985), so the old app's `{ role: "system", content: promptSnapshot }` is sent as a normal system message.

### (b) JSON-mode / schema-structured output and decoding with Effect Schema

**Route 1: `generateObject` (schema-structured, strict).** This is the RC's built-in path and the one slopcop's `PolicyAi.ts` uses.

```ts
import { Schema } from "effect"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"

const Listing = Schema.Struct({
  title: Schema.String,
  brand: Schema.optional(Schema.String),
  price: Schema.optional(Schema.Number),
  currency: Schema.optional(Schema.String),
  availability: Schema.optional(Schema.Literals(["in_stock", "out_of_stock", "preorder", "unknown"])),
  sku: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String)
})

const extract = (systemPrompt: string, cleanHtml: string) =>
  LanguageModel.generateObject({
    objectName: "listing",
    schema: Listing,
    prompt: [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: cleanHtml }] }
    ]
  })
// -> Effect<GenerateObjectResponse<{}, typeof Listing.Type>, AiError.AiError, LanguageModel.LanguageModel>
// response.value is the decoded object; response.text is the raw JSON string.
```

What happens under the hood:

- `generateObject` sets `providerOptions.responseFormat = { type: "json", objectName, schema }` (`packages/effect/src/unstable/ai/LanguageModel.ts` lines 884-891) and after the call runs `codecTransformer(options.schema)` then `resolveStructuredOutput(content, codec)` (lines 903-917), which concatenates the response's `text` parts and decodes with `Schema.decodeEffect(Schema.fromJsonString(schema))`; an empty text yields `StructuredOutputError("No text content in response")` and a decode failure yields `StructuredOutputError.fromSchemaError(error, text)` carrying `responseText` (lines 2256-2284). `codecTransformer` failures surface as `UnsupportedSchemaError` (lines 903-912).
- The compat provider turns that into `response_format: { type: "json_schema", json_schema: { name, description, schema, strict } }` with `strict = config.strictJsonSchema ?? true` (`prepareResponseFormat`, `OpenAiLanguageModel.ts` lines 1921-1936; `toChatResponseFormat`, lines 1617-1641). Test: "uses json_schema format for structured output" asserts `response_format.type === "json_schema"` and `strict === true` (`test/OpenAiLanguageModel.test.ts` lines 758-807).
- The JSON Schema is produced by `toCodecOpenAI` (`packages/effect/src/unstable/ai/OpenAiStructuredOutput.ts`): root must be an object without `anyOf` (it throws otherwise), optional properties become required nullable properties, index signatures become `[key, value]` arrays, unsupported constraints are dropped from the provider schema but still enforced by the returned codec. So `Schema.optional(...)` fields are fine; the model will emit `null` for them and the codec maps back.
- Prompt input: `Prompt.RawInput = string | Iterable<MessageEncoded> | Prompt` (`Prompt.ts` lines 1899-1902); a user message's `content` is an array of `{ type: "text", text }` parts (`UserMessagePart`), a system message's `content` is a string. slopcop's `PolicyAi.ts` shows the exact literal shape.

**Route 2: JSON mode (`json_object`) + manual decode.** This is the parity path with the old app, whose `promptSnapshot` is a user-editable free-form prompt that only promises "a JSON object" (`defaults.ts` `DEFAULT_LISTING_PROMPT`), so there is no fixed schema to hand to `json_schema`.

```ts
const decodeListing = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

const extractJsonMode = (systemPrompt: string, cleanHtml: string) =>
  LanguageModel.generateText({
    prompt: [
      { role: "system", content: systemPrompt },
      { role: "user", content: [{ type: "text", text: cleanHtml }] }
    ]
  }).pipe(
    OpenAiLanguageModel.withConfigOverride({ response_format: { type: "json_object" } }),
    Effect.flatMap((response) =>
      decodeListing(response.text).pipe(
        Effect.map((value) => ({ value, usage: response.usage, finishReason: response.finishReason }))
      )
    )
  )
```

Why this works: for `generateText`, `prepareResponseFormat` returns `{ type: "text" }`, `toChatResponseFormat` returns `undefined` for it, and `toChatCompletionsRequest` spreads `extractCustomRequestProperties(payload)` first and only adds `response_format` when its own value is defined (lines 1553-1571), so a `response_format` supplied through `config` survives as a pass-through key. Verified by reading the code, not by a test; treat as "works by construction, add a unit test capturing the request body like `getRequestBody` in the compat tests". If you need `parseLlmJson`-style repair for parity, run it before `decodeListing`; the old app used `jsonrepair` (`workflow.ts` step 5).

**Reasoning caveat that affects both routes.** glm-4.7-flash is flagged "Reasoning: Yes" on its model page, and the live responses contain `message.reasoning` / `message.reasoning_content` alongside `message.content`. The compat provider handles this: `ChatCompletionMessage` accepts `reasoning` and `reasoning_content` (`OpenAiClient.ts` lines 1113-1119), `makeResponse` pushes a `reasoning` part for them and a `text` part only for `content` (`OpenAiLanguageModel.ts` lines 1075-1084), and `resolveStructuredOutput` only reads `text` parts, so reasoning never pollutes the JSON decode. The cost is budget: probe D (strict `json_schema`, `max_tokens: 1024`, thinking on) produced 4,050 characters of reasoning, `content: null`, `finish_reason: "length"`, which the RC maps to `StructuredOutputError("No text content in response")` with `finishReason === "length"`. Probes B/C/E with `chat_template_kwargs: { enable_thinking: false }` produced no reasoning and clean JSON in 13-16 completion tokens. `chat_template_kwargs` is listed as an input parameter on the model page.

### (c) Read prompt and completion token usage

```ts
const response = yield* extract(prompt, html)
const usage = response.usage                    // Response.Usage
const promptTokens = usage.inputTokens.total ?? 0
const completionTokens = usage.outputTokens.total ?? 0
const totalTokens = promptTokens + completionTokens
const cachedPromptTokens = usage.inputTokens.cacheRead      // from prompt_tokens_details.cached_tokens
const reasoningTokens = usage.outputTokens.reasoning        // from completion_tokens_details.reasoning_tokens
const truncated = response.finishReason === "length"
```

- `GenerateTextResponse.usage` returns the `finish` part's `usage` (or all-`undefined` fields when no finish part exists) and `finishReason` returns the finish part's reason or `"unknown"` (`LanguageModel.ts` lines 428-475). `GenerateObjectResponse` extends it and adds `value` (lines 476-495).
- `Response.Usage` is `{ inputTokens: { uncached?, total?, cacheRead?, cacheWrite? }, outputTokens: { total?, text?, reasoning? } }`, all `Schema.optional(Schema.Int)` (`Response.ts` lines 2387-2422).
- The compat provider's `getUsage` maps `prompt_tokens -> inputTokens.total`, `completion_tokens -> outputTokens.total`, `prompt_tokens_details.cached_tokens -> inputTokens.cacheRead` (and `uncached = total - cached`), `completion_tokens_details.reasoning_tokens -> outputTokens.reasoning` (and `text = total - reasoning`) (`OpenAiLanguageModel.ts` lines 1988-2022).
- Cloudflare's live `usage` object was `{ prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details: { cached_tokens: 0 }, neurons }`. `total_tokens` is not carried separately (sum the two); `neurons` is not surfaced through `Usage` and would require the raw client if ever needed. The old app persisted exactly `prompt_tokens`, `completion_tokens`, `total_tokens` (`workflow.ts` step 6), so parity is the three numbers above.
- `finishReason` values are the closed set `"stop" | "length" | "content-filter" | "tool-calls" | "error" | "pause" | "other" | "unknown"` (`Response.ts` lines 2341-2360); the compat provider maps OpenAI `finish_reason` strings through `resolveFinishReason` (`internal/utilities.ts` lines 12-24). `"length"` is the signal that the old app's "JSON mode not honoured (empty response)" branch was really a truncation.

### (d) Deadline, and mapping timeouts and provider errors into a tagged union

```ts
import { Cause, Data, Duration, Effect } from "effect"
import * as AiError from "effect/unstable/ai/AiError"

export const EXTRACT_DEADLINE = Duration.seconds(60)

export class LlmTimeout extends Data.TaggedError("LlmTimeout")<{ deadline: Duration.Duration }> {}
export class ContextOverflow extends Data.TaggedError("ContextOverflow")<{ description: string }> {}
export class JsonModeUnmet extends Data.TaggedError("JsonModeUnmet")<{ responseText: string; description: string }> {}
export class ProviderError extends Data.TaggedError("ProviderError")<{
  reason: AiError.AiErrorReason["_tag"]; retryable: boolean; retryAfter?: Duration.Duration; cause: AiError.AiError
}> {}
export class UnknownExtractError extends Data.TaggedError("UnknownExtractError")<{ cause: unknown }> {}
export type ExtractError = LlmTimeout | ContextOverflow | JsonModeUnmet | ProviderError | UnknownExtractError

const classify = (error: AiError.AiError): ExtractError => {
  const r = error.reason
  switch (r._tag) {
    case "StructuredOutputError":
      return new JsonModeUnmet({ responseText: r.responseText, description: r.description })
    case "InvalidRequestError":
      return r.description?.includes("5021") || /context window/i.test(r.description ?? "")
        ? new ContextOverflow({ description: r.description ?? "" })
        : new ProviderError({ reason: r._tag, retryable: false, cause: error })
    case "NetworkError": case "InternalProviderError": case "RateLimitError":
    case "QuotaExhaustedError": case "AuthenticationError": case "InvalidOutputError":
    case "ContentPolicyError": case "UnknownError":
      return new ProviderError({ reason: r._tag, retryable: error.isRetryable, retryAfter: error.retryAfter, cause: error })
    default:
      return new UnknownExtractError({ cause: error })
  }
}

export const extractWithDeadline = (systemPrompt: string, html: string) =>
  extract(systemPrompt, html).pipe(
    Effect.timeout(EXTRACT_DEADLINE),
    Effect.catchTags({
      TimeoutError: () => Effect.fail(new LlmTimeout({ deadline: EXTRACT_DEADLINE })),
      AiError: (e) => Effect.fail(classify(e))
    })
  )
// -> Effect<GenerateObjectResponse<...>, ExtractError, LanguageModel.LanguageModel>
```

Facts behind it:

- `Effect.timeout(duration)` has type `<A, E, R>(self) => Effect<A, E | Cause.TimeoutError, R>`; the docs say "If the timeout wins, the source effect is interrupted" and `error._tag // => "TimeoutError"` (`packages/effect/src/Effect.ts` lines 4505-4549). `Cause.TimeoutError` has `_tag: "TimeoutError"` (`Cause.ts` lines 1391-1393). `Effect.timeoutOrElse` / `timeoutOption` exist for other shapes. slopcop applies `Effect.timeout("60 seconds")` directly to `generateObject` (`PolicyAi.ts`). Put the timeout outside the retrying client so retries cannot extend the wall clock.
- Every provider failure is a single `AiError` (`_tag: "AiError"`, fields `module`, `method`, `reason`) with getters `isRetryable` and `retryAfter` delegating to the reason (`AiError.ts` lines 1498-1531). `AiErrorReason` is the union `RateLimitError | QuotaExhaustedError | AuthenticationError | ContentPolicyError | InvalidRequestError | InternalProviderError | NetworkError | InvalidOutputError | StructuredOutputError | UnsupportedSchemaError | UnknownError | ToolNotFoundError | ToolParameterValidationError | InvalidToolResultError | ToolResultEncodingError | ToolConfigurationError | ToolkitRequiredError | InvalidUserInputError` (lines 1375-1393).
- HTTP status mapping in the compat client (`internal/errors.ts` `mapStatusCodeToReason`): 400/404/409/422 -> `InvalidRequestError`; 401 -> `AuthenticationError(kind: "InvalidKey")`; 403 -> `AuthenticationError(kind: "InsufficientPermissions")`; 429 -> `QuotaExhaustedError` when the body's `code`/`type` mentions `insufficient_quota`/`quota`/`exhausted`, else `RateLimitError` with `retryAfter` parsed from `retry-after`; >=500 -> `InternalProviderError`; other -> `UnknownError`. The OpenAI-shaped error body (`{ error: { message, type, code, ... } }`) is decoded into `metadata.openai = { errorCode, errorType, requestId }` (`OpenAiError.ts`). Transport failures become `NetworkError` (`reason: "TransportError" | "EncodeError" | "InvalidUrlError"`), body decode failures become `InvalidOutputError`.
- Retryability per reason (`AiError.ts` `isRetryable` getters): `NetworkError` only when `TransportError`; `RateLimitError`, `InternalProviderError`, `InvalidOutputError`, `StructuredOutputError` true; `QuotaExhaustedError`, `AuthenticationError`, `ContentPolicyError`, `InvalidRequestError`, `UnsupportedSchemaError`, `UnknownError` false.
- Old-app parity: `Extract.classifyError` produced `llm_timeout | invalid_json | json_mode_unmet | context_overflow | provider_error | unknown` (`extract.ts` lines 91-97, 222-287), with `context_overflow` detected by "5021"/"context window" in the message. Whether Cloudflare surfaces the 5021 overflow as HTTP 400 with that text on the chat-completions path is **unverified** (the old app saw it through the binding); keep the message match and confirm with a real oversize prompt.

### (e) Is `@cf/zai-org/glm-4.7-flash` reachable via the OpenAI-compatible path?

Yes, on the REST API path. Live probes on 2026-09-08 with `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`, `Authorization: Bearer <wrangler auth token>`, `cf-aig-gateway-id: default`:

| Probe | `response_format` | `max_tokens` | `enable_thinking` | HTTP | `content` | `finish_reason` | usage (prompt/completion) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `json_object` | 64 | on | 200 | `null` (all budget in `reasoning_content`) | `length` | 25 / 64 |
| A | `json_object` | 1024 | on | 200 | `{"ok": true, "answer": 4}` | `stop` | 29 / 119 |
| B | `json_object` | 128 | off | 200 | `{"ok": true, "answer": 4}` | `stop` | 29 / 16 |
| C | `json_schema` strict | 128 | off | 200 | `{"name": "Ada", "age": 37}` | `stop` | 14 / 13 |
| D | `json_schema` strict | 1024 | on | 200 | `null` (4,050 chars reasoning) | `length` | 14 / 1024 |
| E | none | 32 | off | 200 | `"Hello there."` | `stop` | 11 / 5 |

Every response reported `"model": "@cf/zai-org/glm-4.7-flash"`, `"object": "chat.completion"`, and a `usage` object with `prompt_tokens`, `completion_tokens`, `total_tokens`, `prompt_tokens_details.cached_tokens`, `neurons`. Note that the Workers AI JSON Mode page's "Supported Models" list does not include glm-4.7-flash, yet the model page lists `response_format` as an input parameter and both JSON modes were honored in practice. The JSON Mode page also warns "Workers AI can't guarantee that the model responds according to the requested JSON Schema ... an error `JSON Mode couldn't be met` is returned" and "JSON Mode currently doesn't support streaming".

The `gateway.ai.cloudflare.com/v1/{account}/default/workers-ai/v1/chat/completions` and `/compat/chat/completions` variants returned `401 {"code":2009,"message":"Unauthorized"}` with the wrangler OAuth token. Those hosts may require a scoped API token or `cf-aig-authorization`; not verified, and not needed given the REST API path works and is the one the docs recommend.

### (f) RC API differences from v3 worth noting

Compared against `@effect/ai-openai@0.41.0` / `@effect/ai@0.37.0` (latest v3-era releases on npm):

- **Module location.** Core modules moved from the `@effect/ai` package to `effect/unstable/ai/*` (`LanguageModel`, `Prompt`, `Response`, `AiError`, `Tool`, `Toolkit`, ...). The HTTP client moved from `@effect/platform` to `effect/unstable/http/*`.
- **Chat completions adapter is new.** v3's `OpenAiClient` also posted to `/responses` (`dist/esm/OpenAiClient.js` line 78), so it was already Responses-only; there was no chat-completions adapter in the v3 OpenAI package. `@effect/ai-openai-compat` exists only in the RC line (its CHANGELOG starts in the 4.0.0 betas).
- **Error model.** v3 `AiError` was a flat union `HttpRequestError | HttpResponseError | MalformedInput | MalformedOutput | UnknownError`, each with its own `_tag` (`v3 AiError.d.ts` line 567). RC has a single `AiError` (`_tag: "AiError"`) wrapping `reason: AiErrorReason` (18 semantic tags) plus `isRetryable` / `retryAfter`. `Effect.catchTag("AiError", ...)` then switch on `reason._tag`; provider metadata lives under `reason.metadata.openai`.
- **`layerConfig.apiUrl`** is `Config<string>` in RC versus `Config<string | undefined>` in v3.
- **`generateObject` schema type.** v3 took `Schema.Schema<A, I, R>`; RC takes a v4 `Schema.Encoder<ObjectEncoded, unknown>` and threads a `codecTransformer` (`toCodecOpenAI` in both OpenAI packages) that rewrites the encoded side to the provider's JSON Schema subset. Optional fields therefore become nullable on the wire without you changing the schema.
- **Response shape** is otherwise stable: `GenerateTextResponse.text/usage/finishReason` and `GenerateObjectResponse.value` exist in both (`v3 LanguageModel.d.ts` lines 213, 244).
- **Layer constructors** (`OpenAiClient.layer/layerConfig`, `OpenAiLanguageModel.model/layer/withConfigOverride`, `Config` service with `strictJsonSchema`) keep the same names and roles in v3 and RC.
- **Services** are declared with `Context.Service` in the RC sources (e.g. `class OpenAiClient extends Context.Service<...>()("@effect/ai-openai-compat/OpenAiClient")`); v3 used `Context.Tag`. Not load-bearing for callers, but relevant if you define your own services alongside (slopcop's `PolicyAi` shows the RC style).

## 4. Recommendation

- Depend on `@effect/ai-openai-compat@4.0.0-rc.112` (plus `effect@4.0.0-rc.112`); do not add `@effect/ai-openai`.
- Client layer: `OpenAiClient.layerConfig` with `apiUrl = https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`, bearer = Cloudflare API token holding Workers AI Read (and AI Gateway Read/Edit if you manage the gateway), `transformClient` adding `cf-aig-gateway-id` and `retryTransient`.
- Model layer: `OpenAiLanguageModel.layer({ model: "@cf/zai-org/glm-4.7-flash", config: { max_output_tokens, chat_template_kwargs: { enable_thinking: false } } })`.
- Extraction call: keep the old `json_object` contract for parity via the `response_format` pass-through and decode `response.text` with a permissive schema; migrate to `generateObject` once a per-retailer schema exists. Wrap in `Effect.timeout(60s)` and map `TimeoutError | AiError` into the tagged union above. Persist `usage.inputTokens.total` and `usage.outputTokens.total`; treat `finishReason === "length"` as its own failure.

## 5. Unverified / open items

- The `gateway.ai.cloudflare.com/...` provider and `/compat` hosts (401 with the wrangler OAuth token; not retried with a scoped API token). The docs deprecate `/compat` for this use anyway.
- The exact shape of Cloudflare's context-window-overflow error (code 5021) on the chat-completions path; the old app observed it via the binding.
- The `response_format: json_object` pass-through for `generateText` is established by reading `toChatCompletionsRequest`, not by an existing test; add one.
- Cloudflare's JSON Mode page says the feature "doesn't support streaming"; `streamText` was not tested.
- Whether the wrangler OAuth token's permissions match a production API token's; the docs require Account > Workers AI > Read for `/ai/*`.
- The `neurons` usage field and `cf-aig-*` response headers are not surfaced by the RC `Usage`/`AiError` types; retrieve via the raw `OpenAiClient.createResponse` tuple's `HttpClientResponse` if ever needed.
- The v3 comparison is against the last v3-era npm releases' `.d.ts`/`.js` output, not a source checkout.
