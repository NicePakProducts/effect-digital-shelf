import { expect, it } from "@effect/vitest"
import { Variants } from "@digital-shelf/core/Catalog/Variants"
import { Listings } from "@digital-shelf/core/Catalog/Listings"
import {
  DuplicateVariantName,
  ProductNotFound,
  VariantNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import { ProductId, VariantId } from "@digital-shelf/domain/Shared/Ids"
import { emptyImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import { Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core.ts"
import * as DbTest from "../layers/Db.ts"
import { seed } from "../fixtures/Catalog.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Variants", (it) => {
  it.effect(
    "rejects case-insensitive duplicates within one Product and permits the same name under another",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const a = yield* seed()
        const b = yield* seed()
        const variants = yield* Variants
        yield* variants.create({ productId: a.productId, name: "500 ML" })
        expect(
          yield* Effect.flip(
            variants.create({ productId: a.productId, name: "500 ml" }),
          ),
        ).toEqual(
          new DuplicateVariantName({ productId: a.productId, name: "500 ml" }),
        )
        expect(
          (yield* variants.create({ productId: b.productId, name: "500 ml" }))
            .productId,
        ).toBe(b.productId)
        expect((yield* variants.list({ productId: a.productId })).length).toBe(
          1,
        )
      }),
  )
  it.effect("rejects renaming onto another Variant name", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const { productId } = yield* seed()
      const variants = yield* Variants
      yield* variants.create({ productId, name: "500 ML" })
      const row = yield* variants.create({ productId, name: "1 L" })
      expect(
        yield* Effect.flip(variants.update(row.id, { name: "500 ml" })),
      ).toEqual(new DuplicateVariantName({ productId, name: "500 ml" }))
      expect((yield* variants.get(row.id)).name).toBe("1 L")
    }),
  )
  it.effect(
    "removes only coverage edges and returns empty impact while the Listing survives",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const variants = yield* Variants
        const a = yield* variants.create({ productId: c.productId, name: "A" })
        const b = yield* variants.create({ productId: c.productId, name: "B" })
        const listings = yield* Listings

        const listing = yield* listings.create({
          productId: c.productId,
          retailerId: c.retailerId,
          url: c.url("/item"),
          variantIds: [a.id, b.id],
        })

        expect(yield* variants.remove(a.id)).toEqual(emptyImpact)
        expect((yield* listings.get(listing.id)).variantIds).toEqual([b.id])
      }),
  )
  it.effect("returns the specific missing parent or Variant id", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const variants = yield* Variants
      const id = "00000000-0000-4000-8000-000000000404"
      const productId = Schema.decodeUnknownSync(ProductId)(id)
      const variantId = Schema.decodeUnknownSync(VariantId)(id)
      expect(
        yield* Effect.flip(variants.create({ productId, name: "A" })),
      ).toEqual(new ProductNotFound({ productId }))
      expect(yield* Effect.flip(variants.get(variantId))).toEqual(
        new VariantNotFound({ variantId }),
      )
      expect(
        yield* Effect.flip(variants.update(variantId, { name: "A" })),
      ).toEqual(new VariantNotFound({ variantId }))
      expect(yield* Effect.flip(variants.remove(variantId))).toEqual(
        new VariantNotFound({ variantId }),
      )
    }),
  )
})
