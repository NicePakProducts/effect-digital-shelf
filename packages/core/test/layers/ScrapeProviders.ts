import type { ScrapeMode } from "@app/schema/scraping-vocabulary"
import {
  ScrapeProviders,
  type ScrapeProviderError,
  type ScrapeResult,
  type ScrapeRequest,
} from "@app/core/scrapes/providers"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"

export const fetched = (url: string): ScrapeResult => ({
  html: "<html><body>Hello</body></html>",
  envelope: {
    finalUrl: url,
    statusCode: 200,
    responseHeaders: {},
    cookies: [],
    innerText: "Hello",
    userAgent: "test",
    ipInfo: Option.none(),
    type: "html",
    session: Option.none(),
    raw: {},
    attempts: 1,
  },
})

const make = Effect.gen(function* () {
  const requests = yield* Ref.make<
    ReadonlyArray<{
      readonly mode: ScrapeMode
      readonly request: ScrapeRequest
    }>
  >([])

  const scripts = yield* Ref.make(
    new Map<string, Effect.Effect<ScrapeResult, ScrapeProviderError>>(),
  )

  const script = (
    url: string,
    result: Effect.Effect<ScrapeResult, ScrapeProviderError>,
  ) => Ref.update(scripts, (map) => new Map(map).set(url, result))

  const service: ScrapeProviders.Interface = {
    fetch: (mode, request) =>
      Effect.gen(function* () {
        yield* Ref.update(requests, (calls) => [...calls, { mode, request }])

        return yield* (
          (yield* Ref.get(scripts)).get(request.url) ??
            Effect.succeed(fetched(request.url))
        )
      }),
  }

  return {
    service,
    script,
    requests: Ref.get(requests),
    reset: Effect.gen(function* () {
      yield* Ref.set(scripts, new Map())
      yield* Ref.set(requests, [])
    }),
  }
})

export class ScrapeProvidersTest extends Context.Service<
  ScrapeProvidersTest,
  Effect.Success<typeof make>
>()("@app/core/test/layers/ScrapeProviders", { make }) {}

export const TestLayer = Layer.effect(
  ScrapeProviders.Service,
  Effect.map(ScrapeProvidersTest, (test) => test.service),
).pipe(
  Layer.provideMerge(
    Layer.effect(ScrapeProvidersTest, ScrapeProvidersTest.make),
  ),
)
