import type { Brand } from "@digital-shelf/domain/Catalog/Brand"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  type CascadeImpact,
  emptyImpact,
} from "@digital-shelf/domain/Catalog/CascadeImpact"
import { expect, it } from "@effect/vitest"
import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { BrandsRepo } from "@digital-shelf/core/Catalog/repositories/BrandsRepo"
import { Db } from "@digital-shelf/core/Sql/Db"
import { BrandNotFound } from "@digital-shelf/domain/Catalog/Errors"
import { BrandId } from "@digital-shelf/domain/Shared/Ids"
import { DateTime, Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core.ts"
import * as DbTest from "../layers/Db.ts"

const missingId = Schema.decodeUnknownSync(BrandId)(
  "00000000-0000-4000-8000-000000000404",
)

// Booting PGlite and pushing the schema is slow on a cold cache, slower still
// when another file boots its own PGlite alongside.
it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Brands", (it) => {
  it.effect("creates a Brand and reads it back in the domain vocabulary", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const brands = yield* Brands

      const create: Effect.Effect<Brand, SqlError, never> = brands.create({
        name: "Gaia",
      })

      const created = yield* create
      expect(created.name).toBe("Gaia")
      expect(created.paused).toBe(false)
      expect(DateTime.isDateTime(created.createdAt)).toBe(true)

      const get: Effect.Effect<Brand, BrandNotFound | SqlError, never> =
        brands.get({ brandId: created.id })

      expect(yield* get).toEqual(created)

      const list: Effect.Effect<
        ReadonlyArray<Brand>,
        SqlError,
        never
      > = brands.list

      expect(yield* list).toEqual([created])
    }),
  )

  it.effect("updates and removes, then fails with BrandNotFound", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const brands = yield* Brands
      const created = yield* brands.create({ name: "Gaia" })

      const update: Effect.Effect<Brand, BrandNotFound | SqlError, never> =
        brands.update({ brandId: created.id, command: { paused: true } })

      const paused = yield* update
      expect(paused.paused).toBe(true)
      expect(
        yield* brands.update({ brandId: created.id, command: {} }),
      ).toEqual(paused)

      const impact: Effect.Effect<
        CascadeImpact,
        BrandNotFound | SqlError,
        never
      > = brands.impact({ brandId: created.id })

      expect(yield* impact).toEqual(emptyImpact)

      const remove: Effect.Effect<
        CascadeImpact,
        BrandNotFound | SqlError,
        never
      > = brands.remove({ brandId: created.id })

      const removed = yield* remove
      expect(removed).toEqual(emptyImpact)
      expect(yield* brands.list).toEqual([])
      expect(
        yield* Effect.flip(brands.get({ brandId: created.id })),
      ).toBeInstanceOf(BrandNotFound)
      expect(yield* Effect.flip(brands.get({ brandId: missingId }))).toEqual(
        new BrandNotFound({ brandId: missingId }),
      )
    }),
  )

  /** A repository constructed before the transaction opens joins it over the single test Db. */
  it.effect("repository queries join the enclosing transaction", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const db = yield* Db
      const repo = yield* BrandsRepo

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
