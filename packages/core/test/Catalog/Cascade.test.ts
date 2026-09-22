import { BrandsErrors, Brands } from "@app/core/brands"
import {
  CascadeRoot,
  type CascadeImpact,
  emptyImpact,
} from "@app/schema/cascade"
import { CascadeRepo } from "../../src/cascade/repository"
import { Scrape } from "@app/schema/scrape"
import { R2Bucket } from "@app/core/storage/r2-bucket"
import { BrandsRepo } from "../../src/brands/repository"
import { VariantsRepo } from "../../src/products/variants/repository"
import { expect, it } from "@effect/vitest"
import { Products } from "@app/core/products"
import { ProductVariants } from "@app/core/products/variants"
import { Retailers } from "@app/core/retailers"
import { Listings } from "@app/core/listings"
import { Pages } from "@app/core/pages"
import { Cascade } from "@app/core/cascade"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { keysOf } from "@app/core/scrapes/r2-keys"
import { BrandId } from "@app/schema/ids"
import { sql } from "drizzle-orm"
import type { Brand } from "@app/schema/brand"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Array, Effect, Layer, Schema } from "effect"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"
import { R2BucketTest } from "../layers/R2Bucket"
import { seed } from "../fixtures/Catalog"
import { history, extraction } from "../fixtures/Scraping"

const brandImpact = {
  products: 2,
  variants: 3,
  listings: 2,
  pages: 1,
  scrapes: 3,
}

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Cascade", (it) => {
  it.effect(
    "counts each root's descendants, excludes the root and does not count Extractions",
    () =>
      Effect.gen(function* () {
        const brands = yield* Brands.Service
        const retailers = yield* Retailers.Service
        const products = yield* Products.Service
        const listings = yield* Listings.Service
        const pages = yield* Pages.Service
        yield* DbTest.reset
        const c = yield* tree
        const cascade = yield* Cascade.Service
        expect(yield* brands.impact({ brandId: c.brandId })).toEqual(
          brandImpact,
        )
        expect(yield* retailers.impact({ retailerId: c.retailerId })).toEqual({
          ...brandImpact,
          products: 0,
          variants: 0,
        })
        expect(yield* products.impact({ productId: c.productId })).toEqual({
          products: 0,
          variants: 2,
          listings: 1,
          pages: 0,
          scrapes: 1,
        })
        expect(yield* listings.impact({ listingId: c.listingId })).toEqual({
          ...emptyImpact,
          scrapes: 1,
        })
        expect(yield* pages.impact({ pageId: c.pageId })).toEqual({
          ...emptyImpact,
          scrapes: 1,
        })
        expect(
          yield* cascade.impact(CascadeRoot.Variant({ id: c.variantId })),
        ).toEqual(emptyImpact)
      }),
    60_000,
  )
  it.effect(
    "removes the Brand subtree and its R2 objects while preserving the shared Retailer",
    () =>
      Effect.gen(function* () {
        const brands = yield* Brands.Service
        const bucket = yield* R2BucketTest
        yield* DbTest.reset
        const c = yield* tree
        expect(yield* brands.remove({ brandId: c.brandId })).toEqual(
          brandImpact,
        )
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
        expect((yield* bucket.inspect).size).toBe(0)
      }),
    60_000,
  )
  it.effect(
    "commits row deletion even when R2 deletion fails and leaves the orphan keys",
    () =>
      Effect.gen(function* () {
        const brands = yield* Brands.Service
        yield* DbTest.reset
        const c = yield* tree
        const bucket = yield* R2BucketTest
        yield* bucket.failNextDelete
        expect(yield* brands.remove({ brandId: c.brandId })).toEqual(
          brandImpact,
        )
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
        const brands = yield* Brands.Service
        const bucket = yield* R2BucketTest
        yield* DbTest.reset
        const c = yield* tree
        const before = yield* remaining

        const id = Schema.decodeUnknownSync(BrandId)(
          "00000000-0000-4000-8000-000000000404",
        )

        expect(yield* Effect.flip(brands.remove({ brandId: id }))).toEqual(
          new BrandsErrors.NotFound({ brandId: id }),
        )
        expect(yield* remaining).toEqual(before)
        expect(new Set((yield* bucket.inspect).keys())).toEqual(new Set(c.keys))
      }),
    60_000,
  )
  it.effect(
    "rolls back a failed caller delete without touching R2",
    () =>
      Effect.gen(function* () {
        const cascade = yield* Cascade.Service
        const bucket = yield* R2BucketTest
        yield* DbTest.reset
        const c = yield* tree
        const before = yield* remaining
        expect(
          yield* Effect.flip(
            cascade.remove(
              CascadeRoot.Brand({ id: c.brandId }),
              Effect.fail("refused"),
            ),
          ),
        ).toBe("refused")
        expect(yield* remaining).toEqual(before)
        expect((yield* bucket.inspect).size).toBe(c.keys.length)
      }),
    60_000,
  )
  /**
   * The repository yielded before cascade.remove opens its transaction deletes
   * inside it: the caller's failure restores the row and leaves R2 untouched.
   * PGlite uses one in-process session; a second Db over a separate PGlite
   * database would fail with BrandNotFound instead of "after delete". The
   * two-connection hazard is proved on PostgreSQL in Layering.postgres.test.ts.
   */
  it.effect(
    "rolls back a real delete through the repository service when the caller fails afterwards",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* tree
        const before = yield* remaining
        const cascade = yield* Cascade.Service
        const brandsRepo = yield* BrandsRepo.Service
        const bucket = yield* R2BucketTest

        const impact: Effect.Effect<CascadeImpact, SqlError, never> =
          cascade.impact(CascadeRoot.Brand({ id: c.brandId }))

        expect(yield* impact).toEqual(brandImpact)

        const remove: Effect.Effect<
          { readonly removed: Brand.Info; readonly impact: CascadeImpact },
          BrandsRepo.MissingBrand | SqlError | "after delete",
          never
        > = cascade.remove(
          CascadeRoot.Brand({ id: c.brandId }),
          brandsRepo
            .remove(c.brandId)
            .pipe(Effect.andThen(Effect.fail("after delete" as const))),
        )

        const failed = yield* Effect.flip(remove)
        expect(failed).toBe("after delete")
        expect(yield* remaining).toEqual(before)
        expect(new Set((yield* bucket.inspect).keys())).toEqual(new Set(c.keys))
      }).pipe(Effect.provide(BrandsRepo.layer)),
    60_000,
  )
  it.effect(
    "deleting a Retailer preserves Products and Variants",
    () =>
      Effect.gen(function* () {
        const retailers = yield* Retailers.Service
        const bucket = yield* R2BucketTest
        yield* DbTest.reset
        const c = yield* tree
        expect(yield* retailers.remove({ retailerId: c.retailerId })).toEqual({
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
        expect((yield* bucket.inspect).size).toBe(0)
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
        const brands = yield* Brands.Service
        const brandsRepo = yield* BrandsRepo.Service
        const sizes: number[] = []
        const variantsRepo = yield* VariantsRepo.Service

        const cascade = yield* Cascade.Service.pipe(
          Effect.provide(Layer.fresh(Cascade.layerNoDeps)),
          Effect.provideService(R2Bucket.Service, {
            ...bucket.service,
            delete: (keys) =>
              Effect.gen(function* () {
                expect((yield* brands.list).length).toBe(0)
                sizes.push(keys.length)
                yield* bucket.service.delete(keys)
              }),
          }),
          Effect.provide(CascadeRepo.layer),
        )

        const variant = yield* cascade.remove(
          CascadeRoot.Variant({ id: c.variantId }),
          variantsRepo.remove(c.variantId),
        )

        expect(variant.removed.id).toBe(c.variantId)
        expect(variant.impact).toEqual(emptyImpact)
        expect(sizes).toEqual([])

        yield* Effect.forEach(
          Array.range(1, 498),
          () =>
            Effect.gen(function* () {
              const scrape = yield* history(
                Scrape.Parent.members[0].make({ listingId: c.listingId }),
                "success",
                "1 hour",
              )

              for (const key of keysOf(scrape.id))
                yield* bucket.service.put(key, "payload", "text/plain")
            }),
          { discard: true },
        )

        const removed = yield* cascade.remove(
          CascadeRoot.Brand({ id: c.brandId }),
          brandsRepo.remove(c.brandId),
        )

        expect(removed.removed.id).toBe(c.brandId)
        expect(removed.impact.scrapes).toBe(501)
        expect(sizes).toEqual([1000, 2])
        expect((yield* bucket.inspect).size).toBe(0)
      }).pipe(Effect.provide([BrandsRepo.layer, VariantsRepo.layer])),
    60_000,
  )
})

const tree = Effect.gen(function* () {
  const c = yield* seed()

  const products = yield* Products.Service

  const product = yield* products.create({
    brandId: c.brandId,
    name: "Second",
  })

  const variants = yield* ProductVariants.Service
  const first = yield* variants.create({ productId: c.productId, name: "A" })
  yield* variants.create({ productId: c.productId, name: "B" })
  yield* variants.create({ productId: product.id, name: "C" })
  const listings = yield* Listings.Service

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

  const pages = yield* Pages.Service

  const page = yield* pages.create({
    brandId: c.brandId,
    retailerId: c.retailerId,
    url: c.url("/brand"),
  })

  const s1 = yield* history(
    Scrape.Parent.members[0].make({ listingId: l1.id }),
    "success",
    "1 hour",
  )

  const s2 = yield* history(
    Scrape.Parent.members[0].make({ listingId: l2.id }),
    "success",
    "1 hour",
  )

  const s3 = yield* history(
    Scrape.Parent.members[1].make({ pageId: page.id }),
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
