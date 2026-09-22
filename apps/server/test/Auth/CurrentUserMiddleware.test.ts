import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"
import { expect, it } from "@effect/vitest"
import { Auth } from "@app/core/auth"
import { CurrentUser, CurrentUserMiddleware } from "@app/protocol/auth/security"
import { CurrentUserMiddlewareLayer } from "../../src/auth/current-user-middleware"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
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

      const AuthLayer = Layer.succeed(Auth.Service, {
        getSession: (headers) => {
          expect(new Headers(headers).get("cookie")).toBe(
            "better-auth.session_token=x",
          )

          return Effect.succeed(
            authenticated ? Option.some(user) : Option.none(),
          )
        },
        handle: () => Effect.succeed(new Response()),
      })

      return Effect.gen(function* () {
        const middleware = yield* CurrentUserMiddleware

        const handler = Effect.gen(function* () {
          called = true
          expect(yield* CurrentUser).toEqual(user)

          return HttpServerResponse.text("ok")
        })

        // SAFETY: This middleware ignores its options; the value is never read.
        const result = yield* middleware(handler, undefined as never).pipe(
          Effect.result,
        )

        expect(called).toBe(authenticated)

        if (authenticated) expect(result._tag).toBe("Success")
        else {
          expect(result._tag).toBe("Failure")

          if (Result.isFailure(result))
            expect(result.failure).toBeInstanceOf(HttpApiError.Unauthorized)
        }
      }).pipe(
        Effect.provide(
          CurrentUserMiddlewareLayer.pipe(Layer.provide(AuthLayer)),
        ),
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
