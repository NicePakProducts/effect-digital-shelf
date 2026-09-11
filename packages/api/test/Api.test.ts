import * as Api from "@digital-shelf/api/Api"
import { Auth } from "@digital-shelf/core/Auth/Auth"
import * as CoreTest from "@digital-shelf/core/test/layers/Core"
import { FileSystem, Layer, Option, Path } from "effect"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { packageName } from "@digital-shelf/api"

describe("@digital-shelf/api", () => {
  it.effect("runs an Effect on the RC toolchain", () =>
    Effect.gen(function* () {
      const name = yield* Effect.succeed(packageName)
      expect(name).toBe("@digital-shelf/api")
    }),
  )
})

const platform = HttpPlatform.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(FileSystem.layerNoop({}), Etag.layer, Path.layer),
  ),
)

const auth = Layer.succeed(Auth, {
  getSession: () => Effect.succeed(Option.none()),
  handle: () => Effect.die(new Error("Auth routes are mounted by the app")),
  api: undefined as never,
})

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "Api.layer composition",
  (it) => {
    const app = Effect.gen(function* () {
      const context =
        yield* Effect.context<Layer.Success<typeof CoreTest.layerTest>>()

      return yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            Api.layer.pipe(
              Layer.provide(auth),
              Layer.provide(Layer.succeedContext(context)),
              Layer.provide(platform),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      )
    })

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
