import { BrandNotFound } from "@app/protocol/brands"
import {
  InvalidRetailerDomain,
  RetailerDomainTaken,
  UrlHostMismatch,
} from "@app/protocol/retailers"
import { VariantNotInProduct } from "@app/protocol/listings"
import { PageAlreadyExists } from "@app/protocol/pages"
import { DuplicateVariantName } from "@app/protocol/product-variants"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as TestClock from "effect/testing/TestClock"
import { expect, it } from "@effect/vitest"
import * as ApiTest from "../layers/Api"
import * as DbTest from "@app/core/test/layers/Db"
import { BrandId } from "@app/schema/ids"
import { DateTime, Effect, Layer, Schema } from "effect"
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest"
import { Api } from "@app/protocol/api"

const TestLayer = ApiTest.TestLayer

const client = HttpApiTest.groups(Api, [
  "brands",
  "products",
  "variants",
  "retailers",
  "listings",
  "pages",
])

const missingId = Schema.decodeUnknownSync(BrandId)(
  "00000000-0000-4000-8000-000000000404",
)

it.layer(TestLayer, { timeout: "60 seconds" })("Catalog handlers", (it) => {
  it.effect("PATCH updates a Brand and returns changed ISO timestamps", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const api = yield* client
      const brand = yield* api.brands.create({ payload: { name: "Patch" } })
      yield* TestClock.adjust("1 second")

      const [updated, response] = yield* api.brands.update({
        params: { id: brand.id },
        payload: { paused: true },
        responseMode: "decoded-and-response",
      })

      expect(response.status).toBe(200)
      expect(updated.paused).toBe(true)
      expect(yield* response.json).toEqual({
        id: brand.id,
        name: brand.name,
        paused: true,
        createdAt: DateTime.formatIso(brand.createdAt),
        updatedAt: DateTime.formatIso(updated.updatedAt),
      })
      expect(DateTime.formatIso(updated.updatedAt)).not.toBe(
        DateTime.formatIso(brand.updatedAt),
      )
    }),
  )
  it.effect("PATCH rejects a taken Retailer domain with HTTP 409", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const api = yield* client

      const holder = yield* api.retailers.create({
        payload: { name: "Holder", domain: "taken.example.com" },
      })

      const other = yield* api.retailers.create({
        payload: { name: "Other", domain: "other.example.com" },
      })

      const response = yield* api.retailers.update({
        params: { id: other.id },
        payload: { domain: holder.domain },
        responseMode: "response-only",
      })

      expect(response.status).toBe(409)
      expect(yield* response.json).toEqual({
        // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Assert the serialized error contract independently of its constructor.
        _tag: "RetailerDomainTaken",
        domain: holder.domain,
        retailerId: holder.id,
      })
    }),
  )
  it.effect("returns HTTP 400 for an invalid Brand id", () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<Layer.Success<typeof TestLayer>>()

      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(Api).pipe(
              Layer.provide(Layer.succeedContext(context)),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      )

      const response = yield* Effect.promise(() =>
        app.handler(new Request("http://localhost/api/v1/brands/nope")),
      )

      expect(response.status).toBe(400)
    }).pipe(Effect.scoped),
  )
  it.effect(
    "creates a Brand with ISO timestamps on the wire and reads it through get and list",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client

        const [brand, response] = yield* api.brands.create({
          payload: { name: "Gaia" },
          responseMode: "decoded-and-response",
        })

        expect(response.status).toBe(201)
        expect(brand.paused).toBe(false)
        expect(yield* response.json).toMatchObject({
          createdAt: DateTime.formatIso(brand.createdAt),
          updatedAt: DateTime.formatIso(brand.updatedAt),
        })
        expect(yield* api.brands.get({ params: { id: brand.id } })).toEqual(
          brand,
        )
        expect(yield* api.brands.list()).toEqual({ items: [brand] })
      }),
  )
  it.effect(
    "decodes a BrandNotFound body and preserves the missing id and 404 status",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client

        const error = yield* Effect.flip(
          api.brands.get({ params: { id: missingId } }),
        )

        expect(error).toBeInstanceOf(BrandNotFound)
        expect(error).toEqual(new BrandNotFound({ brandId: missingId }))

        const response = yield* api.brands.get({
          params: { id: missingId },
          responseMode: "response-only",
        })

        expect(response.status).toBe(404)
        expect(yield* response.json).toEqual({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Assert the serialized error contract independently of its constructor.
          _tag: "BrandNotFound",
          brandId: missingId,
        })
      }),
  )
  it.effect(
    "filters Products by Brand and rejects creation under a missing Brand",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client
        const a = yield* api.brands.create({ payload: { name: "A" } })
        const b = yield* api.brands.create({ payload: { name: "B" } })

        const product = yield* api.products.create({
          payload: { brandId: a.id, name: "Wash" },
        })

        yield* api.products.create({
          payload: { brandId: b.id, name: "Other" },
        })
        expect(yield* api.products.list({ query: { brandId: a.id } })).toEqual({
          items: [product],
        })
        expect(
          yield* Effect.flip(
            api.products.create({
              payload: { brandId: missingId, name: "Missing" },
            }),
          ),
        ).toEqual(new BrandNotFound({ brandId: missingId }))
      }),
  )
  it.effect(
    "returns DuplicateVariantName and HTTP 409 for a case-insensitive duplicate",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client
        const brand = yield* api.brands.create({ payload: { name: "Gaia" } })

        const product = yield* api.products.create({
          payload: { brandId: brand.id, name: "Wash" },
        })

        yield* api.variants.create({
          payload: { productId: product.id, name: "500 ML" },
        })
        const payload = { productId: product.id, name: "500 ml" }
        expect(yield* Effect.flip(api.variants.create({ payload }))).toEqual(
          new DuplicateVariantName(payload),
        )
        expect(
          (yield* api.variants.create({
            payload,
            responseMode: "response-only",
          })).status,
        ).toBe(409)
      }),
  )
  it.effect(
    "canonicalises Retailer domains and sends typed domain errors",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client

        const retailer = yield* api.retailers.create({
          payload: { name: "Shop", domain: "https://www.Example.com.au/x" },
        })

        expect(retailer.domain).toBe("example.com.au")
        expect(
          yield* Effect.flip(
            api.retailers.create({
              payload: { name: "Other", domain: "example.com.au" },
            }),
          ),
        ).toEqual(
          new RetailerDomainTaken({
            domain: "example.com.au",
            retailerId: retailer.id,
          }),
        )
        const payload = { name: "Invalid", domain: "not a host" }
        expect(yield* Effect.flip(api.retailers.create({ payload }))).toEqual(
          new InvalidRetailerDomain({ input: "not a host" }),
        )
        expect(
          (yield* api.retailers.create({
            payload,
            responseMode: "response-only",
          })).status,
        ).toBe(422)
      }),
  )
  it.effect(
    "returns Listing coverage and derived readings with null lastScrapedAt, rejecting foreign coverage",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client
        const brand = yield* api.brands.create({ payload: { name: "Gaia" } })

        const product = yield* api.products.create({
          payload: { brandId: brand.id, name: "Wash" },
        })

        const other = yield* api.products.create({
          payload: { brandId: brand.id, name: "Other" },
        })

        const variant = yield* api.variants.create({
          payload: { productId: product.id, name: "500 ml" },
        })

        const foreign = yield* api.variants.create({
          payload: { productId: other.id, name: "500 ml" },
        })

        const retailer = yield* api.retailers.create({
          payload: { name: "Shop", domain: "example.com.au" },
        })

        const payload = {
          productId: product.id,
          retailerId: retailer.id,
          url: "https://example.com.au/item",
          variantIds: [variant.id],
        }

        const listing = yield* api.listings.create({ payload })
        expect(listing).toMatchObject({
          variantIds: [variant.id],
          effectivePaused: false,
          combinedStatus: "none",
          lastScrapedAt: null,
        })
        expect(
          yield* Effect.flip(
            api.listings.create({
              payload: { ...payload, variantIds: [foreign.id] },
            }),
          ),
        ).toEqual(
          new VariantNotInProduct({
            productId: product.id,
            variantId: foreign.id,
          }),
        )
      }),
  )
  it.effect(
    "returns PageAlreadyExists for a repeated Brand and Retailer pair",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client
        const brand = yield* api.brands.create({ payload: { name: "Gaia" } })

        const retailer = yield* api.retailers.create({
          payload: { name: "Shop", domain: "example.com.au" },
        })

        const payload = {
          brandId: brand.id,
          retailerId: retailer.id,
          url: "https://example.com.au/brand",
        }

        const page = yield* api.pages.create({ payload })
        expect(yield* Effect.flip(api.pages.create({ payload }))).toEqual(
          new PageAlreadyExists({
            brandId: brand.id,
            retailerId: retailer.id,
            pageId: page.id,
          }),
        )
      }),
  )
  it.effect(
    "returns UrlHostMismatch as 422 on a Listing, a Page and a domain change",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client
        const brand = yield* api.brands.create({ payload: { name: "Gaia" } })

        const product = yield* api.products.create({
          payload: { brandId: brand.id, name: "Wash" },
        })

        const retailer = yield* api.retailers.create({
          payload: { name: "Shop", domain: "example.com.au" },
        })

        const off = "https://elsewhere.com.au/item"

        const mismatch = {
          url: off,
          domain: "example.com.au",
          listingIds: [],
          pageIds: [],
        }

        expect(
          yield* Effect.flip(
            api.listings.create({
              payload: {
                productId: product.id,
                retailerId: retailer.id,
                url: off,
              },
            }),
          ),
        ).toEqual(new UrlHostMismatch(mismatch))
        expect(
          yield* Effect.flip(
            api.pages.create({
              payload: {
                brandId: brand.id,
                retailerId: retailer.id,
                url: off,
              },
            }),
          ),
        ).toEqual(new UrlHostMismatch(mismatch))
        expect(
          (yield* api.pages.create({
            payload: {
              brandId: brand.id,
              retailerId: retailer.id,
              url: off,
            },
            responseMode: "response-only",
          })).status,
        ).toBe(422)

        const page = yield* api.pages.create({
          payload: {
            brandId: brand.id,
            retailerId: retailer.id,
            url: "https://www.example.com.au/brand",
          },
        })

        expect(
          yield* Effect.flip(
            api.retailers.update({
              params: { id: retailer.id },
              payload: { domain: "elsewhere.com.au" },
            }),
          ),
        ).toEqual(
          new UrlHostMismatch({
            url: "https://www.example.com.au/brand",
            domain: "elsewhere.com.au",
            listingIds: [],
            pageIds: [page.id],
          }),
        )
      }),
  )
  it.effect(
    "previews and removes a Brand tree with the same impact then returns BrandNotFound",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const api = yield* client
        const brand = yield* api.brands.create({ payload: { name: "Gaia" } })

        const product = yield* api.products.create({
          payload: { brandId: brand.id, name: "Wash" },
        })

        const variant = yield* api.variants.create({
          payload: { productId: product.id, name: "500 ml" },
        })

        const retailer = yield* api.retailers.create({
          payload: { name: "Shop", domain: "example.com.au" },
        })

        yield* api.listings.create({
          payload: {
            productId: product.id,
            retailerId: retailer.id,
            url: "https://example.com.au/item",
            variantIds: [variant.id],
          },
        })
        yield* api.pages.create({
          payload: {
            brandId: brand.id,
            retailerId: retailer.id,
            url: "https://example.com.au/brand",
          },
        })
        const params = { id: brand.id }

        const impact = {
          products: 1,
          variants: 1,
          listings: 1,
          pages: 1,
          scrapes: 0,
        }

        expect(yield* api.brands.impact({ params })).toEqual(impact)

        const [removed, response] = yield* api.brands.remove({
          params,
          responseMode: "decoded-and-response",
        })

        expect(removed).toEqual(impact)
        expect(response.status).toBe(200)
        expect(yield* Effect.flip(api.brands.get({ params }))).toEqual(
          new BrandNotFound({ brandId: brand.id }),
        )
      }),
  )
})
