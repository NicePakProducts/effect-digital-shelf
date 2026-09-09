import { Auth } from "@digital-shelf/core/Auth/Auth"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"
import { CurrentUser, CurrentUserMiddleware } from "./Security.ts"

export const layer = Layer.effect(
  CurrentUserMiddleware,
  Effect.gen(function* () {
    const auth = yield* Auth
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const user = yield* auth.getSession(request.headers)
        if (Option.isNone(user)) return yield* new HttpApiError.Unauthorized({})
        yield* Effect.annotateCurrentSpan("shelf.user.id", user.value.id)
        return yield* Effect.provideService(httpEffect, CurrentUser, user.value)
      })
  }),
)
