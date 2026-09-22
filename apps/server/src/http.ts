import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar"
import { Api } from "@app/protocol/api"
import { CurrentUserMiddlewareLayer } from "./auth/current-user-middleware"
import { BrandsHandlersLayer } from "./handlers/brands"
import { ProductsHandlersLayer } from "./handlers/products"
import { ProductVariantsHandlersLayer } from "./handlers/products/variants"
import { RetailersHandlersLayer } from "./handlers/retailers"
import { ListingsHandlersLayer } from "./handlers/listings"
import { PagesHandlersLayer } from "./handlers/pages"
import { ScrapesHandlersLayer } from "./handlers/scrapes"
import { ExtractionsHandlersLayer } from "./handlers/scrapes/extractions"
import { PingHandlersLayer } from "./handlers/ping"
import { AuthRoutesLayer } from "./auth/routes"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { stageOf } from "@app/infra/Resources/Names"
import { Stage } from "alchemy/Stage"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"

export * as Http from "./http"

/** The application supplies public capabilities and HTTP platform services. */
export const layer = Layer.mergeAll(
  HttpApiBuilder.layer(Api, { openapiPath: "/api/openapi.json" }),
  HttpApiScalar.layer(Api, { path: "/api/docs" }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      BrandsHandlersLayer,
      ProductsHandlersLayer,
      ProductVariantsHandlersLayer,
      RetailersHandlersLayer,
      ListingsHandlersLayer,
      PagesHandlersLayer,
      ScrapesHandlersLayer,
      ExtractionsHandlersLayer,
      PingHandlersLayer,
    ),
  ),
  Layer.provide(CurrentUserMiddlewareLayer),
)

const PlatformLayer = Layer.mergeAll(
  Etag.layer,
  Path.layer,
  FileSystem.layerNoop({}),
  // SAFETY: no route serves files or negotiates compression; reaching one of
  // these is a routing bug, not a request the platform could fail on.
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

export const RoutesLayer = Layer.mergeAll(
  layer,
  AuthRoutesLayer,
  Layer.unwrap(
    Effect.gen(function* () {
      const db = yield* Db
      const stage = stageOf(yield* Stage)

      return HttpRouter.add(
        "GET",
        "/health",
        Effect.gen(function* () {
          yield* query(db.execute("select 1"))

          return yield* HttpServerResponse.json({ ok: true, stage, db: "ok" })
        }).pipe(
          // The SqlError message can carry the DSN, so only its reason tag is logged.
          Effect.tapError((error) =>
            Effect.logWarning("Health query failed", error.reason._tag),
          ),
          Effect.catchTag("SqlError", () =>
            HttpServerResponse.json(
              { ok: false, stage, db: "unavailable" },
              { status: 503 },
            ),
          ),
        ),
      )
    }),
  ),
).pipe(Layer.provide(PlatformLayer))
