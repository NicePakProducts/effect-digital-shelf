import { expect, it } from "@effect/vitest"
import { Db } from "@digital-shelf/core/Sql/Db"
import * as CoreTest from "@digital-shelf/core/test/layers/Core"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as Http from "../src/Http.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "server routes",
  (it) => {
    const handler = Effect.gen(function* () {
      const context =
        yield* Effect.context<Layer.Success<typeof CoreTest.layerTest>>()

      const respond = yield* HttpRouter.toHttpEffect(
        Http.layer("dev").pipe(Layer.provide(Layer.succeedContext(context))),
      )

      return yield* respond
    }).pipe(Effect.scoped)

    const request = (path: string) =>
      Effect.gen(function* () {
        const context =
          yield* Effect.context<Layer.Success<typeof CoreTest.layerTest>>()

        const webHandler = HttpEffect.toWebHandler(
          handler.pipe(Effect.provide(context)),
        )

        return yield* Effect.promise(() =>
          webHandler(new Request(`http://localhost${path}`)),
        )
      })

    it.effect("preserves RouteNotFound in the typed HTTP failure channel", () =>
      Effect.gen(function* () {
        const error = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/not-a-route"),
            ),
          ),
          Effect.flip,
        )

        expect(error).toMatchObject({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- This is a partial assertion on an HTTP error, not an error constructor.
          _tag: "HttpServerError",
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- This partial reason pattern intentionally omits RouteNotFound's request.
          reason: { _tag: "RouteNotFound" },
        })
      }),
    )

    it.effect(
      "returns 404 for unknown paths through the Worker fetch handler",
      () =>
        Effect.gen(function* () {
          for (const path of ["/", "/favicon.ico", "/not-a-route"]) {
            const response = yield* request(path)
            expect(response.status).toBe(404)
          }
        }),
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

    it.effect("returns 503 when the health query fails", () =>
      Effect.gen(function* () {
        const db = yield* Db

        yield* db.transaction(() =>
          Effect.gen(function* () {
            // The route joins this fiber's TransactionConnection through the
            // captured context, so the aborted real transaction makes the
            // health SELECT fail too; if that propagation ever changed, the
            // request would hang rather than fail.
            yield* db.execute("select 1 / 0").pipe(Effect.flip)

            const health = yield* request("/health")
            expect(health.status).toBe(503)
            expect(yield* Effect.promise(() => health.json())).toEqual({
              ok: false,
              stage: "dev",
              db: "unavailable",
            })
          }),
        )
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
