import { R2Bucket } from "@digital-shelf/core/Storage/R2Bucket"
import * as BrandsRepo from "@digital-shelf/core/Catalog/repositories/BrandsRepo"
import * as VariantsRepo from "@digital-shelf/core/Catalog/repositories/VariantsRepo"
import { expect, it } from "@effect/vitest"
import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { Products } from "@digital-shelf/core/Catalog/Products"
import { Variants } from "@digital-shelf/core/Catalog/Variants"
import { Retailers } from "@digital-shelf/core/Catalog/Retailers"
import { Listings } from "@digital-shelf/core/Catalog/Listings"
import { Pages } from "@digital-shelf/core/Catalog/Pages"
import { Cascade } from "@digital-shelf/core/Catalog/Cascade"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import { keysOf } from "@digital-shelf/core/Scraping/R2Keys"
import { BrandNotFound } from "@digital-shelf/domain/Catalog/Errors"
import { emptyImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import { BrandId } from "@digital-shelf/domain/Shared/Ids"
import { sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core.ts"
import * as DbTest from "../layers/Db.ts"
import { R2BucketTest } from "../layers/R2Bucket.ts"
import { seed } from "../fixtures/Catalog.ts"
import { history, extraction } from "../fixtures/Scraping.ts"

const tree = Effect.gen(function* () {
  const c = yield* seed()

  const product = yield* (yield* Products).create({
    brandId: c.brandId,
    name: "Second",
  })

  const variants = yield* Variants
  const first = yield* variants.create({ productId: c.productId, name: "A" })
  yield* variants.create({ productId: c.productId, name: "B" })
  yield* variants.create({ productId: product.id, name: "C" })
  const listings = yield* Listings

  const l1 = yield* listings.create({
    productId: c.productId,
    retailerId: c.retailerId,
    url: c.url("/one"),
    variantIds: [first.id],
  })

  const l2 = yield* listings.create({
    productId: product.id,
    retailerId: c.retailerId,
    url: c.url("/two"),
  })

  const page = yield* (yield* Pages).create({
    brandId: c.brandId,
    retailerId: c.retailerId,
    url: c.url("/brand"),
  })

  const s1 = yield* history(
    { _tag: "Listing", listingId: l1.id },
    "success",
    "1 hour",
  )

  const s2 = yield* history(
    { _tag: "Listing", listingId: l2.id },
    "success",
    "1 hour",
  )

  const s3 = yield* history(
    { _tag: "Page", pageId: page.id },
    "success",
    "1 hour",
  )

  yield* extraction(s1.id, 1, "success")
  const keys = [s1.id, s2.id, s3.id].flatMap(keysOf)
  const bucket = yield* R2BucketTest
  yield* bucket.reset

  for (const key of keys)
    yield* bucket.service.put(key, "payload", "text/plain")

  return { ...c, variantId: first.id, listingId: l1.id, pageId: page.id, keys }
})

const brandImpact = {
  products: 2,
  variants: 3,
  listings: 2,
  pages: 1,
  scrapes: 3,
}

const remaining = Effect.gen(function* () {
  const db = yield* Db

  return yield* query(
    db
      .select({
        brands: sql<number>`(select count(*)::int from brands)`,
        products: sql<number>`(select count(*)::int from products)`,
        variants: sql<number>`(select count(*)::int from variants)`,
        listings: sql<number>`(select count(*)::int from listings)`,
        pages: sql<number>`(select count(*)::int from pages)`,
        coverage: sql<number>`(select count(*)::int from listing_variants)`,
        scrapes: sql<number>`(select count(*)::int from scrapes)`,
        extractions: sql<number>`(select count(*)::int from extractions)`,
        retailers: sql<number>`(select count(*)::int from retailers)`,
      })
      .from(sql`(values (1)) as counts(n)`),
  )
})

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Cascade", (it) => {
  it.effect(
    "counts each root's descendants, excludes the root and does not count Extractions",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        const cascade = yield* Cascade
        expect(yield* (yield* Brands).impact(c.brandId)).toEqual(brandImpact)
        expect(yield* (yield* Retailers).impact(c.retailerId)).toEqual({
          ...brandImpact,
          products: 0,
          variants: 0,
        })
        expect(yield* (yield* Products).impact(c.productId)).toEqual({
          products: 0,
          variants: 2,
          listings: 1,
          pages: 0,
          scrapes: 1,
        })
        expect(yield* (yield* Listings).impact(c.listingId)).toEqual({
          ...emptyImpact,
          scrapes: 1,
        })
        expect(yield* (yield* Pages).impact(c.pageId)).toEqual({
          ...emptyImpact,
          scrapes: 1,
        })
        expect(
          yield* cascade.impact({ _tag: "Variant", id: c.variantId }),
        ).toEqual(emptyImpact)
      }),
    60_000,
  )
  it.effect(
    "removes the Brand subtree and its R2 objects while preserving the shared Retailer",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        expect(yield* (yield* Brands).remove(c.brandId)).toEqual(brandImpact)
        expect(yield* remaining).toEqual([
          {
            brands: 0,
            products: 0,
            variants: 0,
            listings: 0,
            pages: 0,
            coverage: 0,
            scrapes: 0,
            extractions: 0,
            retailers: 1,
          },
        ])
        expect((yield* (yield* R2BucketTest).inspect).size).toBe(0)
      }),
    60_000,
  )
  it.effect(
    "commits row deletion even when R2 deletion fails and leaves the orphan keys",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        const bucket = yield* R2BucketTest
        yield* bucket.failNextDelete
        expect(yield* (yield* Brands).remove(c.brandId)).toEqual(brandImpact)
        expect(yield* remaining).toEqual([
          {
            brands: 0,
            products: 0,
            variants: 0,
            listings: 0,
            pages: 0,
            coverage: 0,
            scrapes: 0,
            extractions: 0,
            retailers: 1,
          },
        ])
        expect(new Set((yield* bucket.inspect).keys())).toEqual(new Set(c.keys))
      }),
    60_000,
  )
  it.effect(
    "fails a missing root without deleting any rows or objects",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        const before = yield* remaining

        const id = Schema.decodeUnknownSync(BrandId)(
          "00000000-0000-4000-8000-000000000404",
        )

        expect(yield* Effect.flip((yield* Brands).remove(id))).toEqual(
          new BrandNotFound({ brandId: id }),
        )
        expect(yield* remaining).toEqual(before)
        expect(new Set((yield* (yield* R2BucketTest).inspect).keys())).toEqual(
          new Set(c.keys),
        )
      }),
    60_000,
  )
  it.effect(
    "rolls back a failed caller delete without touching R2",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        const before = yield* remaining
        expect(
          yield* Effect.flip(
            (yield* Cascade).remove(
              { _tag: "Brand", id: c.brandId },
              Effect.fail("refused"),
            ),
          ),
        ).toBe("refused")
        expect(yield* remaining).toEqual(before)
        expect((yield* (yield* R2BucketTest).inspect).size).toBe(c.keys.length)
      }),
    60_000,
  )
  it.effect(
    "deleting a Retailer preserves Products and Variants",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        expect(yield* (yield* Retailers).remove(c.retailerId)).toEqual({
          ...brandImpact,
          products: 0,
          variants: 0,
        })
        expect(yield* remaining).toEqual([
          {
            brands: 1,
            products: 2,
            variants: 3,
            listings: 0,
            pages: 0,
            coverage: 0,
            scrapes: 0,
            extractions: 0,
            retailers: 0,
          },
        ])
        expect((yield* (yield* R2BucketTest).inspect).size).toBe(0)
      }),
    60_000,
  )
  it.effect(
    "deletes R2 in chunks of at most 1000 keys after the rows are gone, skipping empty cleanup",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        const bucket = yield* R2BucketTest
        const sizes: number[] = []

        const cascade = yield* Cascade.make.pipe(
          Effect.provideService(R2Bucket, {
            ...bucket.service,
            delete: (keys) =>
              Effect.gen(function* () {
                expect((yield* BrandsRepo.list()).length).toBe(0)
                sizes.push(keys.length)
                yield* bucket.service.delete(keys)
              }),
          }),
        )

        const variant = yield* cascade.remove(
          { _tag: "Variant", id: c.variantId },
          VariantsRepo.remove(c.variantId),
        )

        expect(variant.removed.id).toBe(c.variantId)
        expect(variant.impact).toEqual(emptyImpact)
        expect(sizes).toEqual([])

        for (let i = 0; i < 498; i++) {
          const scrape = yield* history(
            { _tag: "Listing", listingId: c.listingId },
            "success",
            "1 hour",
          )

          for (const key of keysOf(scrape.id))
            yield* bucket.service.put(key, "payload", "text/plain")
        }

        const removed = yield* cascade.remove(
          { _tag: "Brand", id: c.brandId },
          BrandsRepo.remove(c.brandId),
        )

        expect(removed.removed.id).toBe(c.brandId)
        expect(removed.impact.scrapes).toBe(501)
        expect(sizes).toEqual([1000, 2])
        expect((yield* bucket.inspect).size).toBe(0)
      }),
    60_000,
  )
})
