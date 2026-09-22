import { describe, expect, it } from "@effect/vitest"
import { Brands } from "@app/core/brands"
import { Cascade } from "@app/core/cascade"
import { Products } from "@app/core/products"
import { BrandsRepo } from "../../src/brands/repository"
import { CascadeRoot, emptyImpact } from "@app/schema/cascade"
import * as Layers from "../layers/Features"
import { Db } from "@app/db"
import { Effect, Layer } from "effect"
import * as DbTest from "../layers/Db"
import * as PostgresTest from "../layers/Postgres"
import * as R2BucketTest from "../layers/R2Bucket"

/**
 * Repositories constructed before a transaction opens must join its reserved
 * connection. Unlike PGlite's one session, PostgreSQL's pool can execute a
 * second client's queries on another connection and commit them independently.
 * PostgresTest uses maxConnections: 4, so these rollbacks exercise that hazard.
 * Runs only when DIGITAL_SHELF_TEST_POSTGRES_URL names a disposable PostgreSQL
 * (test/layers/Postgres.ts): vp test --run in this package with the variable
 * set, as CI does over its service container. Without it the block is skipped,
 * and the skip is reported as such.
 */
const TestLayer = Layers.CatalogLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(PostgresTest.TestLayer, R2BucketTest.TestLayer),
  ),
)

describe.skipIf(PostgresTest.url === undefined)(
  "repository layering on PostgreSQL",
  () => {
    it.layer(TestLayer, { timeout: "60 seconds" })(
      "pooled connections",
      (it) => {
        it.effect(
          "a repository constructed before the transaction opens joins it on a pooled connection",
          () =>
            Effect.gen(function* () {
              yield* DbTest.reset
              const repo = yield* BrandsRepo.Service
              const db = yield* Db

              const failed = yield* Effect.flip(
                db.transaction(() =>
                  Effect.gen(function* () {
                    yield* repo.insert({ name: "Rolled back" })

                    return yield* Effect.fail("boom" as const)
                  }),
                ),
              )

              expect(failed).toBe("boom")
              expect(yield* repo.list).toEqual([])
            }).pipe(Effect.provide(BrandsRepo.layer)),
          30_000,
        )

        it.effect(
          "a real delete through the repository service rolls back on PostgreSQL when the caller fails afterwards",
          () =>
            Effect.gen(function* () {
              yield* DbTest.reset
              const brands = yield* Brands.Service
              const products = yield* Products.Service
              const cascade = yield* Cascade.Service
              const brandsRepo = yield* BrandsRepo.Service
              const brand = yield* brands.create({ name: "Rolled back delete" })
              yield* products.create({
                brandId: brand.id,
                name: "Kept product",
              })

              const failed = yield* Effect.flip(
                cascade.remove(
                  CascadeRoot.Brand({ id: brand.id }),
                  brandsRepo
                    .remove(brand.id)
                    .pipe(Effect.andThen(Effect.fail("after delete" as const))),
                ),
              )

              expect(failed).toBe("after delete")
              expect(yield* brands.get({ brandId: brand.id })).toEqual(brand)
              expect(yield* brands.impact({ brandId: brand.id })).toEqual({
                ...emptyImpact,
                products: 1,
              })
            }).pipe(Effect.provide(BrandsRepo.layer)),
          30_000,
        )
      },
    )
  },
)
