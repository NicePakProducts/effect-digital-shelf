import type { Auth } from "@digital-shelf/core/Auth/Auth"
import type { Db } from "@digital-shelf/core/Sql/Db"
import type { R2Bucket } from "@digital-shelf/core/Storage/R2Bucket"
import type { FileSystem } from "effect/FileSystem"
import type { Path } from "effect/Path"
import type * as Etag from "effect/unstable/http/Etag"
import type { HttpPlatform } from "effect/unstable/http/HttpPlatform"
import type * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiScalar from "effect/unstable/httpapi/HttpApiScalar"
import { Catalog } from "@digital-shelf/core/Layers"
import { RootApi } from "./RootApi.ts"
import * as CurrentUserMiddleware from "./Auth/CurrentUserMiddleware.ts"
import * as BrandsHandlers from "./Catalog/BrandsHandlers.ts"
import * as ProductsHandlers from "./Catalog/ProductsHandlers.ts"
import * as VariantsHandlers from "./Catalog/VariantsHandlers.ts"
import * as RetailersHandlers from "./Catalog/RetailersHandlers.ts"
import * as ListingsHandlers from "./Catalog/ListingsHandlers.ts"
import * as PagesHandlers from "./Catalog/PagesHandlers.ts"

/** The app supplies Db, R2Bucket, Auth, HttpRouter and the HTTP platform services
 * (Etag.Generator, FileSystem, HttpPlatform and Path) per invocation.
 * The app also mounts Auth/AuthRoutes.layer itself. */
export const layer: Layer.Layer<
  never,
  never,
  | Db
  | R2Bucket
  | Auth
  | HttpRouter.HttpRouter
  | Etag.Generator
  | FileSystem
  | HttpPlatform
  | Path
> = Layer.mergeAll(
  HttpApiBuilder.layer(RootApi, { openapiPath: "/api/openapi.json" }),
  HttpApiScalar.layer(RootApi, { path: "/api/docs" }),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      BrandsHandlers.layer,
      ProductsHandlers.layer,
      VariantsHandlers.layer,
      RetailersHandlers.layer,
      ListingsHandlers.layer,
      PagesHandlers.layer,
    ).pipe(Layer.provide(Catalog)),
  ),
  Layer.provide(CurrentUserMiddleware.layer),
)
