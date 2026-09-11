import { describe, expect, it } from "@effect/vitest"
import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { Cascade } from "@digital-shelf/core/Catalog/Cascade"
import { Products } from "@digital-shelf/core/Catalog/Products"
import { BrandsRepo } from "@digital-shelf/core/Catalog/repositories/BrandsRepo"
import { CascadeRoot } from "@digital-shelf/core/Catalog/repositories/CascadeRepo"
import * as Layers from "@digital-shelf/core/Layers"
import { Db } from "@digital-shelf/core/Sql/Db"
import { emptyImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import { Effect, Layer } from "effect"
import * as DbTest from "../layers/Db.ts"
import * as PostgresTest from "../layers/Postgres.ts"
import * as R2BucketTest from "../layers/R2Bucket.ts"

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
const layer = Layers.Catalog.pipe(
  Layer.provideMerge(
    Layer.mergeAll(PostgresTest.layerTest, R2BucketTest.layerTest),
  ),
)

describe.skipIf(PostgresTest.url === undefined)(
  "repository layering on PostgreSQL",
  () => {
    it.layer(layer, { timeout: "60 seconds" })("pooled connections", (it) => {
      it.effect(
        "a repository constructed before the transaction opens joins it on a pooled connection",
        () =>
          Effect.gen(function* () {
            yield* DbTest.reset
            const repo = yield* BrandsRepo
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
            const brands = yield* Brands
            const products = yield* Products
            const cascade = yield* Cascade
            const brandsRepo = yield* BrandsRepo
            const brand = yield* brands.create({ name: "Rolled back delete" })
            yield* products.create({ brandId: brand.id, name: "Kept product" })

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
    })
  },
)
