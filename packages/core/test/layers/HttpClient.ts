import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

/**
 * A recording `HttpClient` over canned web responses: the provider modules
 * see the same client the platform gives them, and the test sees every
 * request that actually left, headers and URL included.
 */
export interface Recorded {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

export interface Fixture {
  readonly client: HttpClient.HttpClient
  readonly requests: Effect.Effect<ReadonlyArray<Recorded>>
}

export const respondingWith = (
  respond: (request: Recorded) => Response | Promise<Response> | "never",
): Effect.Effect<Fixture> =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<Recorded>>([])
    const record = (
      request: HttpClientRequest.HttpClientRequest,
      url: URL,
    ): Recorded => ({
      url: url.toString(),
      method: request.method,
      headers: { ...request.headers },
      body:
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : "",
    })
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const recorded = record(request, url)
        yield* Ref.update(requests, (all) => [...all, recorded])
        const response = respond(recorded)
        if (response === "never") return yield* Effect.never
        return HttpClientResponse.fromWeb(
          request,
          yield* Effect.promise(async () => response),
        )
      }),
    )
    return { client, requests: Ref.get(requests) }
  })

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

export const layerTest = (client: HttpClient.HttpClient) =>
  Layer.succeed(HttpClient.HttpClient, client)
