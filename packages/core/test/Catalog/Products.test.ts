import { expect, it } from "@effect/vitest"
import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { Products } from "@digital-shelf/core/Catalog/Products"
import { Variants } from "@digital-shelf/core/Catalog/Variants"
import { Listings } from "@digital-shelf/core/Catalog/Listings"
import {
  BrandNotFound,
  ProductNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import { BrandId, ProductId } from "@digital-shelf/domain/Shared/Ids"
import { Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core.ts"
import * as DbTest from "../layers/Db.ts"
import { seed } from "../fixtures/Catalog.ts"
const missingId = Schema.decodeUnknownSync(BrandId)(
  "00000000-0000-4000-8000-000000000404",
)
it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Products", (it) => {
  it.effect("creates under a Brand with paused false and reads back", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const { productId } = yield* seed()
      const products = yield* Products
      const row = yield* products.get(productId)
      expect(row.paused).toBe(false)
      expect(row.name).toBe("Wash")
    }),
  )
  it.effect("rejects a missing Brand with its id", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      expect(
        yield* Effect.flip(
          (yield* Products).create({ brandId: missingId, name: "Missing" }),
        ),
      ).toEqual(new BrandNotFound({ brandId: missingId }))
    }),
  )
  it.effect("filters by Brand and orders by name", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const a = yield* seed()
      yield* seed()
      const products = yield* Products
      const extra = yield* products.create({ brandId: a.brandId, name: "A" })
      expect(
        (yield* products.list({ brandId: a.brandId })).map((row) => row.id),
      ).toEqual([extra.id, a.productId])
      expect((yield* (yield* Brands).list).length).toBe(2)
    }),
  )
  it.effect("updates and removes with the Product's descendant impact", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* seed()
      const products = yield* Products
      yield* (yield* Variants).create({
        productId: c.productId,
        name: "500 ml",
      })
      yield* (yield* Listings).create({
        productId: c.productId,
        retailerId: c.retailerId,
        url: c.url("/item"),
      })
      expect(
        (yield* products.update(c.productId, { name: "Updated", paused: true }))
          .paused,
      ).toBe(true)
      const impact = {
        products: 0,
        variants: 1,
        listings: 1,
        pages: 0,
        scrapes: 0,
      }
      expect(yield* products.impact(c.productId)).toEqual(impact)
      expect(yield* products.remove(c.productId)).toEqual(impact)
      expect(yield* Effect.flip(products.get(c.productId))).toEqual(
        new ProductNotFound({ productId: c.productId }),
      )
      const missing = Schema.decodeUnknownSync(ProductId)(missingId)
      expect(yield* Effect.flip(products.impact(missing))).toEqual(
        new ProductNotFound({ productId: missing }),
      )
    }),
  )
})
