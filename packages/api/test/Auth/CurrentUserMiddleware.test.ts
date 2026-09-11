import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"
import { expect, it } from "@effect/vitest"
import { Auth } from "@digital-shelf/core/Auth/Auth"
import {
  CurrentUser,
  CurrentUserMiddleware,
} from "@digital-shelf/api/Auth/Security"
import * as Middleware from "@digital-shelf/api/Auth/CurrentUserMiddleware"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

for (const authenticated of [true, false]) {
  it.effect(
    authenticated
      ? "provides CurrentUser to the handler"
      : "rejects an anonymous request before running the handler",
    () => {
      const user = { id: "user-123", email: "user@npbrands.com.au" }
      let called = false

      const auth = Layer.succeed(Auth, {
        getSession: (headers) => {
          expect(new Headers(headers).get("cookie")).toBe(
            "better-auth.session_token=x",
          )

          return Effect.succeed(
            authenticated ? Option.some(user) : Option.none(),
          )
        },
        handle: () => Effect.succeed(new Response()),
        api: undefined as never,
      })

      return Effect.gen(function* () {
        const middleware = yield* CurrentUserMiddleware

        const handler = Effect.gen(function* () {
          called = true
          expect(yield* CurrentUser).toEqual(user)

          return HttpServerResponse.text("ok")
        })

        const result = yield* middleware(handler, undefined as never).pipe(
          Effect.result,
        )

        expect(called).toBe(authenticated)

        if (authenticated) expect(result._tag).toBe("Success")
        else {
          expect(result._tag).toBe("Failure")

          if (result._tag === "Failure")
            expect(result.failure).toBeInstanceOf(HttpApiError.Unauthorized)
        }
      }).pipe(
        Effect.provide(Middleware.layer.pipe(Layer.provide(auth))),
        Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
        Effect.provideService(HttpRouter.RouteContext, {
          route: HttpRouter.route(
            "GET",
            "/api/v1/brands",
            HttpServerResponse.empty(),
          ),
          params: {},
        }),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost/api/v1/brands", {
              headers: { cookie: "better-auth.session_token=x" },
            }),
          ),
        ),
      )
    },
  )
}
