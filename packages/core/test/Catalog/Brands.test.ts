import { expect, it } from "@effect/vitest"
import { Brands } from "@digital-shelf/core/Catalog/Brands"
import * as BrandsRepo from "@digital-shelf/core/Catalog/repositories/BrandsRepo"
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
      const created = yield* brands.create({ name: "Gaia" })
      expect(created.name).toBe("Gaia")
      expect(created.paused).toBe(false)
      expect(DateTime.isDateTime(created.createdAt)).toBe(true)
      expect(yield* brands.get(created.id)).toEqual(created)
      expect(yield* brands.list).toEqual([created])
    }),
  )

  it.effect("updates and removes, then fails with BrandNotFound", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const brands = yield* Brands
      const created = yield* brands.create({ name: "Gaia" })
      const paused = yield* brands.update(created.id, { paused: true })
      expect(paused.paused).toBe(true)
      expect(yield* brands.update(created.id, {})).toEqual(paused)
      const removed = yield* brands.remove(created.id)
      expect(removed.id).toBe(created.id)
      expect(yield* brands.list).toEqual([])
      expect(yield* Effect.flip(brands.get(created.id))).toBeInstanceOf(
        BrandNotFound,
      )
      expect(yield* Effect.flip(brands.get(missingId))).toEqual(
        new BrandNotFound({ brandId: missingId }),
      )
    }),
  )

  it.effect("repository queries join the enclosing transaction", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const db = yield* Db
      const rolledBack = yield* Effect.flip(
        db.transaction(() =>
          Effect.gen(function* () {
            yield* BrandsRepo.insert({ name: "Rolled back" })
            return yield* Effect.fail("boom" as const)
          }),
        ),
      )
      expect(rolledBack).toBe("boom")
      expect(yield* BrandsRepo.list()).toEqual([])

      yield* db.transaction(() => BrandsRepo.insert({ name: "Kept" }))
      expect((yield* BrandsRepo.list()).map((brand) => brand.name)).toEqual([
        "Kept",
      ])
    }),
  )
})
