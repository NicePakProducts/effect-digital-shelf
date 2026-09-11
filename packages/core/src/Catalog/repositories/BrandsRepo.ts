import {
  Brand,
  BrandInsert,
  BrandUpdate,
} from "@digital-shelf/domain/Catalog/Brand"
import { BrandNotFound } from "@digital-shelf/domain/Catalog/Errors"
import type { BrandId } from "@digital-shelf/domain/Shared/Ids"
import { brands } from "@digital-shelf/domain/Sql/Catalog"
import { asc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Brand rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `BrandNotFound`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(Brand)

const all = Rows.decodeAll(Brand)

const exactlyOne = Rows.decodeOne(Brand)

const toRow = Rows.encode(BrandInsert)

const toPatch = Rows.encode(BrandUpdate)

const orNotFound =
  (id: BrandId) =>
  <R>(
    self: Effect.Effect<Option.Option<Brand>, SqlError, R>,
  ): Effect.Effect<Brand, BrandNotFound | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new BrandNotFound({ brandId: id })),
        onSome: Effect.succeed,
      }),
    )

export const find = Effect.fn("BrandsRepo.find", { level: "Debug" })(function* (
  id: BrandId,
) {
  const db = yield* Db

  return yield* one(
    yield* query(db.select().from(brands).where(eq(brands.id, id))),
  )
})

export const get = (id: BrandId) => find(id).pipe(orNotFound(id))

export const list = Effect.fn("BrandsRepo.list", { level: "Debug" })(
  function* () {
    const db = yield* Db

    return yield* all(
      yield* query(
        db
          .select()
          .from(brands)
          .orderBy(asc(brands.name), asc(brands.createdAt)),
      ),
    )
  },
)

export const insert = Effect.fn("BrandsRepo.insert", { level: "Debug" })(
  function* (brand: BrandInsert) {
    const db = yield* Db

    return yield* exactlyOne(
      yield* query(db.insert(brands).values(toRow(brand)).returning()),
    )
  },
)

export const update = Effect.fn("BrandsRepo.update", { level: "Debug" })(
  function* (id: BrandId, patch: BrandUpdate) {
    const values = toPatch(patch)

    if (Object.keys(values).length === 0) return yield* get(id)
    const db = yield* Db

    return yield* one(
      yield* query(
        db.update(brands).set(values).where(eq(brands.id, id)).returning(),
      ),
    ).pipe(orNotFound(id))
  },
)

/** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
export const remove = Effect.fn("BrandsRepo.remove", { level: "Debug" })(
  function* (id: BrandId) {
    const db = yield* Db

    return yield* one(
      yield* query(db.delete(brands).where(eq(brands.id, id)).returning()),
    ).pipe(orNotFound(id))
  },
)
