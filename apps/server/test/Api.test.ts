import * as Api from "../src/http"
import { Auth } from "@app/core/auth"
import * as CoreTest from "@app/core/test/layers/Core"
import { DateTime, FileSystem, Layer, Option, Path, Effect } from "effect"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { expect, it } from "@effect/vitest"

const PlatformLayer = HttpPlatform.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(FileSystem.layerNoop({}), Etag.layer, Path.layer),
  ),
)

const AuthLayer = Layer.succeed(Auth.Service, {
  getSession: () => Effect.succeed(Option.none()),
  handle: () => Effect.die(new Error("Auth routes are mounted by the app")),
})

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })(
  "Api.layer composition",
  (it) => {
    const app = Effect.gen(function* () {
      const context =
        yield* Effect.context<Layer.Success<typeof CoreTest.TestLayer>>()

      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            Api.layer.pipe(
              Layer.provide(AuthLayer),
              Layer.provide(Layer.succeedContext(context)),
              Layer.provide(PlatformLayer),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      )
    })

    it.effect("serves GET /api/v1/ping without a session", () =>
      Effect.gen(function* () {
        const server = yield* app
        const before = yield* DateTime.now

        const response = yield* Effect.promise(() =>
          server.handler(new Request("http://localhost/api/v1/ping")),
        )

        const after = yield* DateTime.now
        const body = yield* Effect.promise(() => response.json())

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain(
          "application/json",
        )
        expect(body).toEqual({
          message: "pong",
          timestamp: expect.any(String),
        })
        expect(body.timestamp >= DateTime.formatIso(before)).toBe(true)
        expect(body.timestamp <= DateTime.formatIso(after)).toBe(true)
      }).pipe(Effect.scoped),
    )
    it.effect("denies GET /api/v1/brands without a session", () =>
      Effect.gen(function* () {
        const server = yield* app

        const response = yield* Effect.promise(() =>
          server.handler(new Request("http://localhost/api/v1/brands")),
        )

        expect(response.status).toBe(401)
      }).pipe(Effect.scoped),
    )
    it.effect("serves GET /api/docs as HTML", () =>
      Effect.gen(function* () {
        const server = yield* app

        const response = yield* Effect.promise(() =>
          server.handler(new Request("http://localhost/api/docs")),
        )

        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/html")
        expect(yield* Effect.promise(() => response.text())).toContain("<html")
      }).pipe(Effect.scoped),
    )
    it.effect("serves GET /api/openapi.json with the API title", () =>
      Effect.gen(function* () {
        const server = yield* app

        const response = yield* Effect.promise(() =>
          server.handler(new Request("http://localhost/api/openapi.json")),
        )

        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          info: { title: "Digital Shelf" },
        })
      }).pipe(Effect.scoped),
    )
  },
)
