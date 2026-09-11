import * as Api from "@digital-shelf/api/Api"
import * as AuthRoutes from "@digital-shelf/api/Auth/AuthRoutes"
import { Db } from "@digital-shelf/core/Sql/Db"
import type { Stage } from "@digital-shelf/infra/Resources/Names"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

const platform = Layer.mergeAll(
  Etag.layer,
  Path.layer,
  FileSystem.layerNoop({}),
  Layer.succeed(HttpPlatform.HttpPlatform, {
    platform: "web",
    compression: {
      algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
      compressResponse: () => Effect.die("HTTP compression not configured"),
    },
    fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
    fileWebResponse: () =>
      Effect.die("HttpPlatform.fileWebResponse not supported"),
  }),
)

export const layer = (stage: Stage) =>
  Layer.mergeAll(
    Api.layer,
    AuthRoutes.layer,
    Layer.unwrap(
      Effect.gen(function* () {
        const db = yield* Db
        return HttpRouter.add(
          "GET",
          "/health",
          Effect.gen(function* () {
            yield* db.execute("select 1").pipe(Effect.orDie)
            return yield* HttpServerResponse.json({ ok: true, stage, db: "ok" })
          }),
        )
      }),
    ),
  ).pipe(Layer.provide(platform))
