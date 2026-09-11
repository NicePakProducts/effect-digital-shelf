import { expect, it } from "@effect/vitest"
import * as CoreTest from "@digital-shelf/core/test/layers/Core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Http from "../src/Http.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "server routes",
  (it) => {
    const request = (path: string) =>
      Effect.gen(function* () {
        const context =
          yield* Effect.context<Layer.Success<typeof CoreTest.layerTest>>()
        const handler = yield* HttpRouter.toHttpEffect(
          Http.layer("dev").pipe(Layer.provide(Layer.succeedContext(context))),
        )
        const response = yield* handler
        return HttpServerResponse.toWeb(response)
      }).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(`http://localhost${path}`)),
        ),
        Effect.scoped,
      )

    it.effect(
      "serves the health query, docs, and middleware refusal through the per-request router",
      () =>
        Effect.gen(function* () {
          const health = yield* request("/health")
          expect(health.status).toBe(200)
          expect(yield* Effect.promise(() => health.json())).toEqual({
            ok: true,
            stage: "dev",
            db: "ok",
          })
          const docs = yield* request("/api/docs")
          expect(docs.status).toBe(200)
          expect(yield* Effect.promise(() => docs.text())).toContain(
            "api-reference",
          )
          const brands = yield* request("/api/v1/brands")
          expect(brands.status).toBe(401)
        }),
    )

    it.effect("mounts the Better Auth handler", () =>
      Effect.gen(function* () {
        const response = yield* request("/api/auth/ok")
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          ok: true,
        })
      }),
    )
  },
)
