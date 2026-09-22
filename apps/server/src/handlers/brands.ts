import { BrandNotFound } from "@app/protocol/brands"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { Brands } from "@app/core/brands"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { Api } from "@app/protocol/api"
import { toWire } from "@app/protocol/brand-wire"

export const BrandsHandlersLayer = HttpApiBuilder.group(
  Api,
  "brands",
  (handlers) =>
    Effect.gen(function* () {
      const brands = yield* Brands.Service

      return handlers
        .handle("list", () =>
          brands.list.pipe(
            Effect.map((rows) => ({ items: rows.map(toWire) })),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Brands.list persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("get", ({ params }) =>
          brands.get({ brandId: params.id }).pipe(
            Effect.catchTag("BrandNotFound", (error) =>
              Effect.fail(new BrandNotFound({ brandId: error.brandId })),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Brands.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("create", ({ payload }) =>
          brands.create(payload).pipe(
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Brands.create persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("update", ({ params, payload }) =>
          brands.update({ brandId: params.id, command: payload }).pipe(
            Effect.catchTag("BrandNotFound", (error) =>
              Effect.fail(new BrandNotFound({ brandId: error.brandId })),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Brands.update persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("impact", ({ params }) =>
          brands.impact({ brandId: params.id }).pipe(
            Effect.catchTag("BrandNotFound", (error) =>
              Effect.fail(new BrandNotFound({ brandId: error.brandId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Brands.impact persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("remove", ({ params }) =>
          brands.remove({ brandId: params.id }).pipe(
            Effect.catchTag("BrandNotFound", (error) =>
              Effect.fail(new BrandNotFound({ brandId: error.brandId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Brands.remove persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
    }),
)
