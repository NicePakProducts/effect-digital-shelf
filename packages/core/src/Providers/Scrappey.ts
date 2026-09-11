import type { ScrapeEnvelope } from "@digital-shelf/domain/Scraping/ScrapeEnvelope"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import {
  ScrapeProviderError,
  type ScrapeProviderErrorCode,
  type ScrapeRequest,
  type ScrapeResult,
} from "./ScrapeProviders.ts"

/**
 * `advance` mode: one `request.get` against Scrappey, whose managed browser
 * session renders the page from the requested country and answers with the
 * whole envelope in `solution`. The runner owns the Scrape deadline, the
 * inner-text cap and the R2 puts; this module calls, maps and classifies.
 *
 * Scrappey takes its key in the query string, so the key is applied inside
 * the transport, after the client span is built: a `Redacted` value must not
 * reach a span attribute. Trace propagation is off for the same reason a
 * third party gets no `traceparent` of ours (#28); the local client span
 * stays.
 */

export const ENDPOINT = "https://publisher.scrappey.com/api/v1"

/** Everything of the response we read; the rest travels in `raw`. */
const Solution = Schema.Struct({
  currentUrl: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  statusCode: Schema.optionalKey(Schema.Int),
  responseHeaders: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.String),
  ),
  cookies: Schema.optionalKey(Schema.Json),
  innerText: Schema.optionalKey(Schema.String),
  userAgent: Schema.optionalKey(Schema.String),
  ipInfo: Schema.optionalKey(Schema.Json),
  type: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(Schema.String),
})

const Body = Schema.Struct({
  solution: Schema.optionalKey(Solution),
  session: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})

type Body = typeof Body.Type

const decodeBody = Schema.decodeUnknownEffect(Body)

const decodeJson = Schema.decodeUnknownEffect(Schema.Json)

const isJsonObject = (json: Schema.Json): json is Schema.JsonObject =>
  json !== null && typeof json === "object" && !Array.isArray(json)

/** The vendor payload with the HTML stripped: forensics only (#13). */
const withoutHtml = (json: Schema.Json): Schema.Json => {
  if (!isJsonObject(json)) return json
  const { solution, ...rest } = json

  if (solution === undefined || !isJsonObject(solution)) return json
  const { response: _html, ...kept } = solution

  return { ...rest, solution: kept }
}

/**
 * Scrappey's stable `CODE-XXXX` identifiers are the canonical key; the
 * message is only a fallback for anything the table has not seen. Retries
 * are for the provider's own transients, never for a block, a navigation
 * failure or a bad URL (#13).
 */
const VERIFICATION = new Set([
  "CODE-0002",
  "CODE-0003",
  "CODE-0007",
  "CODE-0008",
  "CODE-0010",
  "CODE-0011",
  "CODE-0012",
  "CODE-0013",
  "CODE-0014",
  "CODE-0017",
  "CODE-0018",
  "CODE-0022",
  "CODE-0023",
  "CODE-0028",
  "CODE-0032",
  "CODE-0033",
  "CODE-0034",
  "CODE-0035",
  "CODE-0037",
])

const TRANSIENT = new Set([
  "CODE-0001",
  "CODE-0005",
  "CODE-0009",
  "CODE-0019",
  "CODE-0021",
  "CODE-0024",
  "CODE-0025",
  "CODE-0026",
  "CODE-0029",
  "CODE-0031",
  "CODE-10000",
])

const NAVIGATION = new Set(["CODE-0006"])

export const classifyError = (
  message: string,
): { readonly code: ScrapeProviderErrorCode; readonly retryable: boolean } => {
  const code = /CODE-\d+/.exec(message)?.[0]

  if (code !== undefined) {
    if (VERIFICATION.has(code)) return { code: "blocked", retryable: false }

    if (NAVIGATION.has(code))
      return { code: "navigation_failed", retryable: false }

    if (TRANSIENT.has(code)) return { code: "provider_error", retryable: true }

    return { code: "provider_error", retryable: false }
  }

  if (/invalid url|url is required|not a valid url/i.test(message))
    return { code: "invalid_url", retryable: false }

  if (/captcha|verification|blocked|forbidden/i.test(message))
    return { code: "blocked", retryable: false }

  if (/timeout|timed out|net::ERR_|could not load/i.test(message))
    return { code: "navigation_failed", retryable: false }

  return { code: "provider_error", retryable: false }
}

/** Scrappey's own transport status, not the target's. */
export const classifyStatus = (
  status: number,
): { readonly code: ScrapeProviderErrorCode; readonly retryable: boolean } => ({
  code: "provider_error",
  retryable: status === 408 || status === 429 || status >= 500,
})

const providerError = (
  classification: {
    readonly code: ScrapeProviderErrorCode
    readonly retryable: boolean
  },
  message: string,
  detail: unknown,
) =>
  new ScrapeProviderError({
    ...classification,
    message,
    // Stamped by the caller, which owns the attempt count.
    attempts: 1,
    detail,
  })

/**
 * The key belongs to the transport, not to the span: `HttpClient.make` builds
 * the client span from the request it is handed, so adding the query
 * parameter here keeps it out of `url.full` and `url.query`, and the inner
 * client's own span is suppressed so it cannot re-add it. Propagation is
 * disabled so no `traceparent` of ours leaves for a third party (#28).
 */
export const clientFor = (
  client: HttpClient.HttpClient,
  apiKey: Redacted.Redacted<string>,
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    client
      .execute(
        HttpClientRequest.setUrlParam(request, "key", Redacted.value(apiKey)),
      )
      // The inner client would otherwise open a second span, over the URL
      // that now carries the key.
      .pipe(Effect.provideService(HttpClient.TracerDisabledWhen, () => true)),
  ).pipe(
    HttpClient.transformResponse(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    ),
  )

const envelopeOf = (
  request: ScrapeRequest,
  body: Body,
  solution: NonNullable<Body["solution"]>,
  statusCode: number,
  raw: Schema.Json,
): ScrapeEnvelope => ({
  finalUrl: solution.currentUrl ?? solution.url ?? request.url,
  statusCode,
  responseHeaders: solution.responseHeaders ?? {},
  cookies: solution.cookies ?? [],
  innerText: solution.innerText ?? "",
  userAgent: solution.userAgent ?? "",
  ipInfo:
    solution.ipInfo === undefined
      ? Option.none()
      : Option.some(solution.ipInfo),
  type: solution.type ?? "html",
  session:
    body.session === undefined ? Option.none() : Option.some(body.session),
  raw,
  attempts: 1,
})

/** One Fetch attempt against Scrappey. */
export const fetchOnce = (options: {
  readonly client: HttpClient.HttpClient
  readonly endpoint: string
  readonly request: ScrapeRequest
  readonly deadline: Duration.Duration
}): Effect.Effect<ScrapeResult, ScrapeProviderError> =>
  Effect.gen(function* () {
    const response = yield* options.client
      .execute(
        HttpClientRequest.post(options.endpoint).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            cmd: "request.get",
            url: options.request.url,
            ...(Option.isSome(options.request.country)
              ? { proxyCountry: options.request.country.value }
              : {}),
          }),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          providerError(
            { code: "provider_error", retryable: true },
            `Scrappey request failed: ${error.reason._tag}`,
            { reason: error.reason._tag },
          ),
        ),
      )

    if (response.status < 200 || response.status >= 300)
      return yield* Effect.fail(
        providerError(
          classifyStatus(response.status),
          `Scrappey answered ${response.status}`,
          { status: response.status },
        ),
      )

    const unread = providerError(
      { code: "provider_error", retryable: false },
      "Scrappey answered a body this client cannot read",
      null,
    )

    const json = yield* response.json.pipe(
      Effect.flatMap(decodeJson),
      Effect.mapError(() => unread),
    )

    const body = yield* decodeBody(json).pipe(Effect.mapError(() => unread))

    if (body.error !== undefined || body.data === "error")
      return yield* Effect.fail(
        providerError(
          classifyError(body.error ?? ""),
          body.error ?? "Scrappey reported an unspecified error",
          { error: body.error ?? null },
        ),
      )
    const solution = body.solution

    if (solution === undefined || solution.response === undefined)
      return yield* Effect.fail(
        providerError(
          { code: "provider_error", retryable: false },
          "Scrappey answered without a rendered page",
          null,
        ),
      )

    if (solution.statusCode === undefined)
      return yield* Effect.fail(
        providerError(
          { code: "provider_error", retryable: false },
          "Scrappey answered without a status code",
          null,
        ),
      )

    return {
      envelope: envelopeOf(
        options.request,
        body,
        solution,
        solution.statusCode,
        withoutHtml(json),
      ),
      html: solution.response,
    }
  }).pipe(
    Effect.timeout(options.deadline),
    Effect.catchTag("TimeoutError", () =>
      Effect.fail(
        providerError(
          { code: "navigation_failed", retryable: false },
          "Fetch attempt deadline exceeded",
          null,
        ),
      ),
    ),
  )
