import { RootApi } from "@digital-shelf/api/RootApi"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as AtomHttpApi from "effect/unstable/reactivity/AtomHttpApi"

export class ApiClient extends AtomHttpApi.Service<ApiClient>()(
  "@digital-shelf/web/ApiClient",
  {
    api: RootApi,
    httpClient: FetchHttpClient.layer,
  },
) {}
