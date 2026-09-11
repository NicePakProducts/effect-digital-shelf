import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { Cascade } from "@digital-shelf/core/Catalog/Cascade"
import { CascadeRoot } from "@digital-shelf/core/Catalog/repositories/CascadeRepo"
import * as Layers from "@digital-shelf/core/Layers"
import { Db } from "@digital-shelf/core/Sql/Db"
import { emptyImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as Sql from "@digital-shelf/domain/Sql/index"
import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import { describe, expect, it } from "@effect/vitest"
import { PGlite } from "@electric-sql/pglite"
import { pushSchema } from "drizzle-kit/api-postgres"
import * as PgDrizzle from "drizzle-orm/effect-pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as R2BucketTest from "../layers/R2Bucket.ts"

describe("Catalog layers", () => {
  /**
   * Brands.layer, Cascade.layer, BrandsRepo.layer, CascadeRepo.layer and the
   * five other features require Db. Stable layer references deduplicate its
   * construction within one memo map; Db is observable because repositories
   * remain private to their features.
   */
  it.effect(
    "one Db per build however many features and repositories require it",
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
          const cascade = yield* Cascade
          const brand = yield* brands.create({ name: "Shared database" })
          expect(yield* brands.get({ brandId: brand.id })).toEqual(brand)
          expect(
            yield* cascade.impact(CascadeRoot.Brand({ id: brand.id })),
          ).toEqual(emptyImpact)
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
