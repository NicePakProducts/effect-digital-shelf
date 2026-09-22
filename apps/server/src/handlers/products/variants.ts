import {
  DuplicateVariantName,
  VariantNotFound,
} from "@app/protocol/product-variants"
import { ProductNotFound } from "@app/protocol/products"
import { ProductVariants } from "@app/core/products/variants"
import * as Effect from "effect/Effect"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { Api } from "@app/protocol/api"
import { toWire } from "@app/protocol/product-variant-wire"

export const ProductVariantsHandlersLayer = HttpApiBuilder.group(
  Api,
  "variants",
  (handlers) =>
    Effect.gen(function* () {
      const variants = yield* ProductVariants.Service

      return handlers
        .handle("list", ({ query }) =>
          variants.list(query).pipe(
            Effect.map((rows) => ({ items: rows.map(toWire) })),
            Effect.catchTag("SqlError", () =>
              Effect.logError("ProductVariants.list persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("get", ({ params }) =>
          variants.get({ variantId: params.id }).pipe(
            Effect.map(toWire),
            Effect.catchTag("VariantNotFound", (error) =>
              Effect.fail(new VariantNotFound({ variantId: error.variantId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("ProductVariants.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("create", ({ payload }) =>
          variants.create(payload).pipe(
            Effect.map(toWire),
            Effect.catchTag("ProductNotFound", (error) =>
              Effect.fail(new ProductNotFound({ productId: error.productId })),
            ),
            Effect.catchTag("DuplicateVariantName", (error) =>
              Effect.fail(
                new DuplicateVariantName({
                  productId: error.productId,
                  name: error.name,
                }),
              ),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("ProductVariants.create persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("update", ({ params, payload }) =>
          variants.update({ variantId: params.id, command: payload }).pipe(
            Effect.map(toWire),
            Effect.catchTag("VariantNotFound", (error) =>
              Effect.fail(new VariantNotFound({ variantId: error.variantId })),
            ),
            Effect.catchTag("DuplicateVariantName", (error) =>
              Effect.fail(
                new DuplicateVariantName({
                  productId: error.productId,
                  name: error.name,
                }),
              ),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("ProductVariants.update persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("remove", ({ params }) =>
          variants.remove({ variantId: params.id }).pipe(
            Effect.catchTag("VariantNotFound", (error) =>
              Effect.fail(new VariantNotFound({ variantId: error.variantId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("ProductVariants.remove persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
    }),
)
