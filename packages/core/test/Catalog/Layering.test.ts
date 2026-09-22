import { R2Bucket } from "@app/core/storage/r2-bucket"
import { Brands } from "@app/core/brands"
import { Cascade } from "@app/core/cascade"
import { Pages } from "@app/core/pages"
import { Products } from "@app/core/products"
import { ProductVariants } from "@app/core/products/variants"
import { Retailers } from "@app/core/retailers"
import { Listings } from "@app/core/listings"
import { ProductsRepo } from "../../src/products/repository"
import { VariantsRepo } from "../../src/products/variants/repository"
import { RetailersRepo } from "../../src/retailers/repository"
import { ListingsRepo } from "../../src/listings/repository"
import { PagesRepo } from "../../src/pages/repository"
import { BrandsRepo } from "../../src/brands/repository"
import { CascadeRepo } from "../../src/cascade/repository"
import { CascadeRoot, emptyImpact } from "@app/schema/cascade"
import * as Layers from "../layers/Features"
import { Db } from "@app/db"
import * as Sql from "@app/db/schema"
import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { PGlite } from "@electric-sql/pglite"
import { pushSchema } from "drizzle-kit/api-postgres"
import * as PgDrizzle from "drizzle-orm/effect-pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as R2BucketTest from "../layers/R2Bucket"

describe("Catalog layers", () => {
  it("default catalog layers leave only Db and object storage open", () => {
    expectTypeOf<
      Layer.Services<
        | typeof Products.layer
        | typeof ProductVariants.layer
        | typeof Brands.layer
        | typeof Retailers.layer
        | typeof Listings.layer
        | typeof Pages.layer
      >
    >().toEqualTypeOf<Db | R2Bucket.Service>()
    expectTypeOf<
      Layer.Services<typeof ProductVariants.layerNoDeps>
    >().toEqualTypeOf<
      Db | Cascade.Service | ProductsRepo.Service | VariantsRepo.Service
    >()
  })

  it("feature methods need no services after construction", () => {
    expectTypeOf<
      Effect.Services<
        | ReturnType<Brands.Interface[Exclude<keyof Brands.Interface, "list">]>
        | Brands.Interface["list"]
        | ReturnType<Cascade.Interface[keyof Cascade.Interface]>
        | ReturnType<Products.Interface[keyof Products.Interface]>
        | ReturnType<ProductVariants.Interface[keyof ProductVariants.Interface]>
        | ReturnType<
            Retailers.Interface[Exclude<keyof Retailers.Interface, "list">]
          >
        | Retailers.Interface["list"]
        | ReturnType<Listings.Interface[keyof Listings.Interface]>
        | ReturnType<Pages.Interface[keyof Pages.Interface]>
      >
    >().toEqualTypeOf<never>()
  })

  /**
   * Effect memoizes layers by object identity within one memo map (ADR 0008).
   * A getter allocating a layer creates a new memo key per access and builds
   * the repository once per feature. Repository instances are private to their
   * features, so the stable field is the observable guard.
   */
  it("every layer is a stable value, never allocated on access", () => {
    for (const service of [
      BrandsRepo,
      CascadeRepo,
      ProductsRepo,
      VariantsRepo,
      RetailersRepo,
      ListingsRepo,
      PagesRepo,
      Brands,
      Cascade,
      Products,
      ProductVariants,
      Retailers,
      Listings,
      Pages,
    ]) {
      expect(service.layer).toBeDefined()
      expect(service.layer).toBe(service.layer)
    }
  })

  it.effect(
    "features built together read one database",
    () =>
      Effect.gen(function* () {
        const counter = { built: 0 }

        const context = yield* Layer.build(
          Layers.CatalogLayer.pipe(
            Layer.provide([countingDb(counter), R2BucketTest.TestLayer]),
          ),
        )

        yield* Effect.gen(function* () {
          const brands = yield* Brands.Service
          const products = yield* Products.Service
          const cascade = yield* Cascade.Service
          const brand = yield* brands.create({ name: "Shared database" })
          yield* products.create({ brandId: brand.id, name: "Shared product" })
          const impact = { ...emptyImpact, products: 1 }
          expect(yield* brands.get({ brandId: brand.id })).toEqual(brand)
          expect(
            yield* cascade.impact(CascadeRoot.Brand({ id: brand.id })),
          ).toEqual(impact)
          expect(yield* brands.impact({ brandId: brand.id })).toEqual(impact)
          expect(counter.built).toBe(1)
        }).pipe(Effect.provide(context))
      }).pipe(Effect.scoped),
    60_000,
  )

  it.effect(
    "independent builds over distinct bindings are isolated",
    () =>
      Effect.gen(function* () {
        const counter = { built: 0 }

        yield* Effect.gen(function* () {
          const context = yield* Layer.build(
            Layers.CatalogLayer.pipe(
              Layer.provide([countingDb(counter), R2BucketTest.TestLayer]),
              Layer.fresh,
            ),
          )

          yield* Effect.gen(function* () {
            const brands = yield* Brands.Service
            const brand = yield* brands.create({ name: "Build A only" })
            expect(yield* brands.list).toEqual([brand])
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped)

        yield* Effect.gen(function* () {
          const context = yield* Layer.build(
            Layers.CatalogLayer.pipe(
              Layer.provide([countingDb(counter), R2BucketTest.TestLayer]),
              Layer.fresh,
            ),
          )

          yield* Effect.gen(function* () {
            const brands = yield* Brands.Service
            expect(yield* brands.list).toEqual([])
            expect(counter.built).toBe(2)
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped)
      }),
    60_000,
  )
})

function countingDb(counter: { built: number }) {
  const boot = Effect.promise(async () => {
    const pglite = new PGlite()
    const schema = await pushSchema(Sql, drizzle({ client: pglite }))
    await schema.apply()

    return pglite
  })

  return Layer.effect(
    Db,
    Effect.gen(function* () {
      counter.built += 1

      return yield* PgDrizzle.makeWithDefaults()
    }),
  ).pipe(
    Layer.provideMerge(
      PgliteClient.layerFrom(
        Effect.flatMap(
          Effect.acquireRelease(boot, (client) =>
            Effect.promise(() => client.close()),
          ),
          (liveClient) => PgliteClient.fromClient({ liveClient }),
        ),
      ),
    ),
  )
}
