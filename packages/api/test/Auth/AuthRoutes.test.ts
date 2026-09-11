import { expect, it } from "@effect/vitest"
import { Auth } from "@digital-shelf/core/Auth/Auth"
import * as AuthRoutes from "@digital-shelf/api/Auth/AuthRoutes"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/unstable/http/HttpRouter"

it.effect(
  "forwards auth and discovery URLs and preserves the response, leaving api/v1 alone",
  () =>
    Effect.gen(function* () {
      const requests: Array<{ url: string; method: string; body: string }> = []

      const auth = Layer.succeed(Auth, {
        getSession: () => Effect.succeed(Option.none()),
        handle: (request) =>
          Effect.promise(async () => {
            requests.push({
              url: request.url,
              method: request.method,
              body: await request.text(),
            })

            return new Response("auth response", { status: 202 })
          }),
        // SAFETY: AuthRoutes only calls handle; the api value is never read.
        api: undefined as never,
      })

      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(AuthRoutes.layer.pipe(Layer.provide(auth)), {
            disableLogger: true,
          }),
        ),
        (app) => Effect.promise(() => app.dispose()),
      )

      for (const path of [
        "/api/auth/get-session",
        "/api/auth/magic-link/verify",
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
      ]) {
        const url = `http://localhost${path}`

        const response = yield* Effect.promise(() =>
          app.handler(new Request(url)),
        )

        expect(response.status).toBe(202)
        expect(yield* Effect.promise(() => response.text())).toBe(
          "auth response",
        )
        expect(requests.at(-1)?.url).toBe(url)
      }

      const body = '{ "email": "someone@npbrands.com.au", "callbackURL": "/" }'
      const signInUrl = "http://localhost/api/auth/sign-in/magic-link"

      const signInResponse = yield* Effect.promise(() =>
        app.handler(
          new Request(signInUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
        ),
      )

      expect(signInResponse.status).toBe(202)
      expect(yield* Effect.promise(() => signInResponse.text())).toBe(
        "auth response",
      )
      expect(requests.at(-1)).toEqual({ url: signInUrl, method: "POST", body })

      const response = yield* Effect.promise(() =>
        app.handler(new Request("http://localhost/api/v1/anything")),
      )

      expect(response.status).toBe(404)
      expect(requests).toHaveLength(5)
    }).pipe(Effect.scoped),
)
