import { BrandsErrors, Brands } from "@app/core/brands"
import { ProductsErrors } from "@app/core/products"
import { ProductVariantsErrors } from "@app/core/products/variants"
import { ProductNotFound } from "@app/protocol/products"
import { BrandNotFound } from "@app/protocol/brands"
import { BrandId, ProductId } from "@app/schema/ids"
import { Api } from "@app/protocol/api"
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest"
import {
  DuplicateVariantName,
  VariantNotFound,
} from "@app/protocol/product-variants"
import { expect, it } from "@effect/vitest"
import { ApiClient, layerNoDeps } from "@app/client"
import { Scrape } from "@app/schema/scrape"
import { Url } from "@app/schema/refine"
import { Effect, Layer, Schema } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as DbTest from "@app/core/test/layers/Db"
import * as ApiTest from "./layers/Api"

const missingId = Schema.decodeUnknownSync(ProductId)(
  "00000000-0000-4000-8000-000000000404",
)

it.layer(ApiTest.TestLayer, { timeout: "60 seconds" })(
  "packaged generated client",
  (it) => {
    it.effect(
      "core Brand errors remain catchable and HTTP owns their independent encoding",
      () =>
        Effect.gen(function* () {
          yield* DbTest.reset
          const brandId = Schema.decodeUnknownSync(BrandId)(missingId)
          const brands = yield* Brands.Service
          const coreError = yield* brands.get({ brandId }).pipe(Effect.flip)
          expect(coreError).toBeInstanceOf(BrandsErrors.NotFound)
          expect(
            yield* brands
              .get({ brandId })
              .pipe(
                Effect.catchTag("BrandNotFound", (error) =>
                  Effect.succeed(error.brandId),
                ),
              ),
          ).toBe(brandId)

          const api = yield* HttpApiTest.groups(Api, ["brands"])

          const error = yield* api.brands
            .get({ params: { id: brandId } })
            .pipe(Effect.flip)

          expect(error).toBeInstanceOf(BrandNotFound)
          expect(error).not.toBeInstanceOf(BrandsErrors.NotFound)

          if (!(error instanceof BrandNotFound))
            return yield* Effect.fail(error)
          const encoded = Schema.encodeSync(BrandNotFound)(error)
          expect(Object.keys(encoded).sort()).toEqual(["_tag", "brandId"])
          expect(encoded._tag).toBe("BrandNotFound")
          expect(encoded.brandId).toBe(brandId)
        }),
    )
    it.effect(
      "round trips Product and Variant CRUD with the existing typed errors",
      () =>
        Effect.gen(function* () {
          yield* DbTest.reset
          const transport = yield* ApiTest.rawClient

          const api = yield* ApiClient.pipe(
            Effect.provide(
              layerNoDeps.pipe(
                Layer.provide(
                  Layer.succeed(
                    HttpClient.HttpClient,
                    transport.pipe(
                      HttpClient.mapRequest(
                        HttpClientRequest.prependUrl("http://localhost"),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          )

          const brand = yield* api.brands.create({
            payload: { name: "Client brand" },
          })

          const product = yield* api.products.create({
            payload: { name: "Client product", brandId: brand.id },
          })

          const found = yield* api.products.get({ params: { id: product.id } })
          expect(found).toEqual(product)

          const variant = yield* api.variants.create({
            payload: { productId: product.id, name: "Small" },
          })

          expect(variant.name).toBe("Small")
          expect(variant.productId).toBe(product.id)

          const duplicate = yield* api.variants
            .create({ payload: { productId: product.id, name: "Small" } })
            .pipe(Effect.flip)

          expect(duplicate).toBeInstanceOf(DuplicateVariantName)
          expect(duplicate).not.toBeInstanceOf(
            ProductVariantsErrors.DuplicateName,
          )

          const updated = yield* api.products.update({
            params: { id: product.id },
            payload: { name: "Updated" },
          })

          expect(updated.name).toBe("Updated")

          const impact = yield* api.products.remove({
            params: { id: product.id },
          })

          expect(impact.variants).toBe(1)

          const missingProduct = yield* api.products
            .get({ params: { id: product.id } })
            .pipe(Effect.flip)

          expect(missingProduct).toEqual(
            new ProductNotFound({ productId: product.id }),
          )
          expect(missingProduct).toBeInstanceOf(ProductNotFound)
          expect(missingProduct).not.toBeInstanceOf(ProductsErrors.NotFound)

          const retailer = yield* api.retailers.create({
            payload: { name: "Product consumer", domain: "example.test" },
          })

          const consumerErrors = [
            yield* api.listings
              .create({
                payload: {
                  productId: missingId,
                  retailerId: retailer.id,
                  url: Schema.decodeUnknownSync(Url)(
                    "https://example.test/missing",
                  ),
                },
              })
              .pipe(Effect.flip),
            yield* api.scrapes
              .bulk({
                payload: Scrape.Bulk.members[1].make({ productId: missingId }),
              })
              .pipe(Effect.flip),
            yield* api.extractions
              .latestForProduct({ params: { id: missingId } })
              .pipe(Effect.flip),
          ]

          for (const error of consumerErrors) {
            expect(error).toEqual(new ProductNotFound({ productId: missingId }))
            expect(error).toBeInstanceOf(ProductNotFound)
            expect(error).not.toBeInstanceOf(ProductsErrors.NotFound)
          }

          const missingVariant = yield* api.variants
            .get({ params: { id: variant.id } })
            .pipe(Effect.flip)

          expect(missingVariant).toEqual(
            new VariantNotFound({ variantId: variant.id }),
          )
          expect(missingVariant).toBeInstanceOf(VariantNotFound)
          expect(missingVariant).not.toBeInstanceOf(
            ProductVariantsErrors.NotFound,
          )

          for (const resource of ["products", "variants"]) {
            const response = yield* transport.get(
              `${ApiTest.baseUrl}/${resource}/${resource === "products" ? product.id : variant.id}`,
            )

            expect(response.status).toBe(404)

            const body = Schema.decodeUnknownSync(Schema.JsonObject)(
              yield* response.json,
            )

            const idKey = resource === "products" ? "productId" : "variantId"
            expect(Object.keys(body).sort()).toEqual(["_tag", idKey])
            expect(body).toHaveProperty(
              "_tag",
              resource === "products" ? "ProductNotFound" : "VariantNotFound",
            )
            expect(body).toHaveProperty(
              idKey,
              resource === "products" ? product.id : variant.id,
            )
          }

          expect(
            yield* api.variants
              .create({ payload: { productId: missingId, name: "Missing" } })
              .pipe(Effect.flip),
          ).toEqual(new ProductNotFound({ productId: missingId }))
        }),
    )
  },
)
