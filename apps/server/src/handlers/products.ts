import { BrandNotFound } from "@app/protocol/brands"
import { ProductNotFound } from "@app/protocol/products"
import { Products } from "@app/core/products"
import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { Api } from "@app/protocol/api"
import { toWire } from "@app/protocol/product-wire"

export const ProductsHandlersLayer = HttpApiBuilder.group(
  Api,
  "products",
  (handlers) =>
    Effect.gen(function* () {
      const products = yield* Products.Service

      return handlers
        .handle("list", ({ query }) =>
          products.list(query).pipe(
            Effect.map((rows) => ({ items: rows.map(toWire) })),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Products.list persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("get", ({ params }) =>
          products.get({ productId: params.id }).pipe(
            Effect.map(toWire),
            Effect.catchTag("ProductNotFound", (error) =>
              Effect.fail(new ProductNotFound({ productId: error.productId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Products.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("create", ({ payload }) =>
          products.create(payload).pipe(
            Effect.catchTag("BrandNotFound", (error) =>
              Effect.fail(new BrandNotFound({ brandId: error.brandId })),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Products.create persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("update", ({ params, payload }) =>
          products.update({ productId: params.id, command: payload }).pipe(
            Effect.map(toWire),
            Effect.catchTag("ProductNotFound", (error) =>
              Effect.fail(new ProductNotFound({ productId: error.productId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Products.update persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("impact", ({ params }) =>
          products.impact({ productId: params.id }).pipe(
            Effect.catchTag("ProductNotFound", (error) =>
              Effect.fail(new ProductNotFound({ productId: error.productId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Products.impact persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("remove", ({ params }) =>
          products.remove({ productId: params.id }).pipe(
            Effect.catchTag("ProductNotFound", (error) =>
              Effect.fail(new ProductNotFound({ productId: error.productId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Products.remove persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
    }),
)
