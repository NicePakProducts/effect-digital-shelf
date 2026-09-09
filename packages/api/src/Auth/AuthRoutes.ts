import { Auth } from "@digital-shelf/core/Auth/Auth"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* Auth
    const handle = (request: HttpServerRequest.HttpServerRequest) =>
      HttpServerRequest.toWeb(request).pipe(
        Effect.orDie,
        Effect.flatMap(auth.handle),
        Effect.map(HttpServerResponse.fromWeb),
      )
    return Layer.mergeAll(
      HttpRouter.add("*", "/api/auth/*", handle),
      HttpRouter.add("*", "/.well-known/*", handle),
    )
  }),
)
