import { BrandsErrors, Brands } from "@app/core/brands"
import type { Brand } from "@app/schema/brand"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { type CascadeImpact, emptyImpact } from "@app/schema/cascade"
import { expect, it } from "@effect/vitest"
import { BrandsRepo } from "../../src/brands/repository"
import { Db } from "@app/db"
import { BrandId } from "@app/schema/ids"
import { DateTime, Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"

const missingId = Schema.decodeUnknownSync(BrandId)(
  "00000000-0000-4000-8000-000000000404",
)

// Booting PGlite and pushing the schema is slow on a cold cache, slower still
// when another file boots its own PGlite alongside.
it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Brands", (it) => {
  it.effect("creates a Brand and reads it back in the domain vocabulary", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const brands = yield* Brands.Service

      const create: Effect.Effect<Brand.Info, SqlError, never> = brands.create({
        name: "Gaia",
      })

      const created = yield* create
      expect(created.name).toBe("Gaia")
      expect(created.paused).toBe(false)
      expect(DateTime.isDateTime(created.createdAt)).toBe(true)

      const get: Effect.Effect<
        Brand.Info,
        BrandsErrors.NotFound | SqlError,
        never
      > = brands.get({ brandId: created.id })

      expect(yield* get).toEqual(created)

      const list: Effect.Effect<
        ReadonlyArray<Brand.Info>,
        SqlError,
        never
      > = brands.list

      expect(yield* list).toEqual([created])
    }),
  )

  it.effect("updates and removes, then fails with BrandNotFound", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const brands = yield* Brands.Service
      const created = yield* brands.create({ name: "Gaia" })

      const update: Effect.Effect<
        Brand.Info,
        BrandsErrors.NotFound | SqlError,
        never
      > = brands.update({ brandId: created.id, command: { paused: true } })

      const paused = yield* update
      expect(paused.paused).toBe(true)
      expect(
        yield* brands.update({ brandId: created.id, command: {} }),
      ).toEqual(paused)

      const impact: Effect.Effect<
        CascadeImpact,
        BrandsErrors.NotFound | SqlError,
        never
      > = brands.impact({ brandId: created.id })

      expect(yield* impact).toEqual(emptyImpact)

      const remove: Effect.Effect<
        CascadeImpact,
        BrandsErrors.NotFound | SqlError,
        never
      > = brands.remove({ brandId: created.id })

      const removed = yield* remove
      expect(removed).toEqual(emptyImpact)
      expect(yield* brands.list).toEqual([])
      expect(
        yield* Effect.flip(brands.get({ brandId: created.id })),
      ).toBeInstanceOf(BrandsErrors.NotFound)
      expect(yield* Effect.flip(brands.get({ brandId: missingId }))).toEqual(
        new BrandsErrors.NotFound({ brandId: missingId }),
      )
    }),
  )

  /** A repository constructed before the transaction opens joins it over the single test Db. */
  it.effect("repository queries join the enclosing transaction", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const db = yield* Db
      const repo = yield* BrandsRepo.Service

      const rolledBack = yield* Effect.flip(
        db.transaction(() =>
          Effect.gen(function* () {
            yield* repo.insert({ name: "Rolled back" })

            return yield* Effect.fail("boom" as const)
          }),
        ),
      )

      expect(rolledBack).toBe("boom")
      expect(yield* repo.list).toEqual([])

      yield* db.transaction(() => repo.insert({ name: "Kept" }))
      expect((yield* repo.list).map((brand) => brand.name)).toEqual(["Kept"])
    }).pipe(Effect.provide(BrandsRepo.layer)),
  )
})
