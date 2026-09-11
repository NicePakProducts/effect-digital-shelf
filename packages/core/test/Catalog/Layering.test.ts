import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { Cascade } from "@digital-shelf/core/Catalog/Cascade"
import { Pages } from "@digital-shelf/core/Catalog/Pages"
import { Products } from "@digital-shelf/core/Catalog/Products"
import { Variants } from "@digital-shelf/core/Catalog/Variants"
import { Retailers } from "@digital-shelf/core/Catalog/Retailers"
import { Listings } from "@digital-shelf/core/Catalog/Listings"
import { ProductsRepo } from "@digital-shelf/core/Catalog/repositories/ProductsRepo"
import { VariantsRepo } from "@digital-shelf/core/Catalog/repositories/VariantsRepo"
import { RetailersRepo } from "@digital-shelf/core/Catalog/repositories/RetailersRepo"
import { ListingsRepo } from "@digital-shelf/core/Catalog/repositories/ListingsRepo"
import { PagesRepo } from "@digital-shelf/core/Catalog/repositories/PagesRepo"
import { BrandsRepo } from "@digital-shelf/core/Catalog/repositories/BrandsRepo"
import { CascadeRepo } from "@digital-shelf/core/Catalog/repositories/CascadeRepo"
import { CascadeRoot } from "@digital-shelf/core/Catalog/repositories/CascadeRepo"
import * as Layers from "@digital-shelf/core/Layers"
import { Db } from "@digital-shelf/core/Sql/Db"
import { emptyImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as Sql from "@digital-shelf/domain/Sql/index"
import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { PGlite } from "@electric-sql/pglite"
import { pushSchema } from "drizzle-kit/api-postgres"
import * as PgDrizzle from "drizzle-orm/effect-pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as R2BucketTest from "../layers/R2Bucket.ts"

describe("Catalog layers", () => {
  it("feature methods need no services after construction", () => {
    expectTypeOf<
      Effect.Services<
        | ReturnType<Products["Service"][keyof Products["Service"]]>
        | ReturnType<Variants["Service"][keyof Variants["Service"]]>
        | ReturnType<
            Retailers["Service"][Exclude<keyof Retailers["Service"], "list">]
          >
        | Retailers["Service"]["list"]
        | ReturnType<Listings["Service"][keyof Listings["Service"]]>
        | ReturnType<Pages["Service"][keyof Pages["Service"]]>
      >
    >().toEqualTypeOf<never>()
  })

  /**
   * Effect memoizes layers by object identity within one memo map (ADR 0008).
   * A getter allocating a layer creates a new memo key per access and builds
   * the repository once per feature. Repository instances are private to their
   * features, so the stable field is the observable guard.
   */
  it("every layer is a stable field, never allocated on access", () => {
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
      Variants,
      Retailers,
      Listings,
      Pages,
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(service, "layer")
      expect(descriptor?.get === undefined).toBe(true)
      expect(descriptor?.value).toBeDefined()
      expect(service.layer).toBe(service.layer)
    }
  })

  it.effect(
    "features built together read one database",
    () =>
      Effect.gen(function* () {
        const counter = { built: 0 }

        const context = yield* Layer.build(
          Layers.Catalog.pipe(
            Layer.provide([countingDb(counter), R2BucketTest.layerTest]),
          ),
        )

        yield* Effect.gen(function* () {
          const brands = yield* Brands
          const products = yield* Products
          const cascade = yield* Cascade
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
            Layers.Catalog.pipe(
              Layer.provide([countingDb(counter), R2BucketTest.layerTest]),
              Layer.fresh,
            ),
          )

          yield* Effect.gen(function* () {
            const brands = yield* Brands
            const brand = yield* brands.create({ name: "Build A only" })
            expect(yield* brands.list).toEqual([brand])
          }).pipe(Effect.provide(context))
        }).pipe(Effect.scoped)

        yield* Effect.gen(function* () {
          const context = yield* Layer.build(
            Layers.Catalog.pipe(
              Layer.provide([countingDb(counter), R2BucketTest.layerTest]),
              Layer.fresh,
            ),
          )

          yield* Effect.gen(function* () {
            const brands = yield* Brands
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
