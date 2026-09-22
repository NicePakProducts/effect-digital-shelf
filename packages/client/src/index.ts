import { Api } from "@app/protocol/api"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient"

export class ApiClient extends Context.Service<
  ApiClient,
  HttpApiClient.ForApi<typeof Api>
>()("@app/client") {}

export const layerNoDeps = Layer.effect(ApiClient, HttpApiClient.make(Api))

/** Relative API paths and Fetch's default same-origin credentials match the browser. */
export const layer = layerNoDeps.pipe(Layer.provide(FetchHttpClient.layer))
