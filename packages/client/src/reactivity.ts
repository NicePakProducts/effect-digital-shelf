import { Api } from "@app/protocol/api"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"

export class ApiClient extends AtomHttpApi.Service<ApiClient>()(
  "@app/web/ApiClient",
  {
    api: Api,
    httpClient: FetchHttpClient.layer,
  },
) {}
