import { BrandsErrors, Brands } from "@app/core/brands"
import { ProductsErrors, Products } from "@app/core/products"
import { expect, it } from "@effect/vitest"
import { ProductVariants } from "@app/core/products/variants"
import { Listings } from "@app/core/listings"
import { BrandId, ProductId } from "@app/schema/ids"
import { Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"
import { seed } from "../fixtures/Catalog"

const missingId = Schema.decodeUnknownSync(BrandId)(
  "00000000-0000-4000-8000-000000000404",
)

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Products", (it) => {
  it.effect("creates under a Brand with paused false and reads back", () =>
    Effect.gen(function* () {
      const products = yield* Products.Service
      yield* DbTest.reset
      const seeded = yield* seed()
      const productId = seeded.productId
      const row = yield* products.get({ productId })
      expect(row.paused).toBe(false)
      expect(row.name).toBe("Wash")
    }),
  )
  it.effect("rejects a missing Brand with its id", () =>
    Effect.gen(function* () {
      const products = yield* Products.Service
      yield* DbTest.reset
      expect(
        yield* Effect.flip(
          products.create({ brandId: missingId, name: "Missing" }),
        ),
      ).toEqual(new BrandsErrors.NotFound({ brandId: missingId }))
    }),
  )
  it.effect("filters by Brand and orders by name", () =>
    Effect.gen(function* () {
      const brands = yield* Brands.Service
      const products = yield* Products.Service
      yield* DbTest.reset
      const a = yield* seed()
      yield* seed()
      const extra = yield* products.create({ brandId: a.brandId, name: "A" })
      expect(
        (yield* products.list({ brandId: a.brandId })).map((row) => row.id),
      ).toEqual([extra.id, a.productId])
      expect((yield* brands.list).length).toBe(2)
    }),
  )
  it.effect("updates and removes with the Product's descendant impact", () =>
    Effect.gen(function* () {
      const listings = yield* Listings.Service
      const variants = yield* ProductVariants.Service
      const products = yield* Products.Service
      yield* DbTest.reset
      const c = yield* seed()
      yield* variants.create({
        productId: c.productId,
        name: "500 ml",
      })
      yield* listings.create({
        productId: c.productId,
        retailerId: c.retailerId,
        url: c.url("/item"),
      })
      expect(
        (yield* products.update({
          productId: c.productId,
          command: { name: "Updated", paused: true },
        })).paused,
      ).toBe(true)

      const impact = {
        products: 0,
        variants: 1,
        listings: 1,
        pages: 0,
        scrapes: 0,
      }

      expect(yield* products.impact({ productId: c.productId })).toEqual(impact)
      expect(yield* products.remove({ productId: c.productId })).toEqual(impact)
      expect(
        yield* Effect.flip(products.get({ productId: c.productId })),
      ).toEqual(new ProductsErrors.NotFound({ productId: c.productId }))
      const missing = Schema.decodeUnknownSync(ProductId)(missingId)
      expect(
        yield* Effect.flip(products.impact({ productId: missing })),
      ).toEqual(new ProductsErrors.NotFound({ productId: missing }))
    }),
  )
})
