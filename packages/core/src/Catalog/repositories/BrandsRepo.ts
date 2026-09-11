import {
  Brand,
  BrandInsert,
  BrandUpdate,
} from "@digital-shelf/domain/Catalog/Brand"
import { BrandNotFound } from "@digital-shelf/domain/Catalog/Errors"
import type { BrandId } from "@digital-shelf/domain/Shared/Ids"
import { brands } from "@digital-shelf/domain/Sql/Catalog"
import { asc, eq } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
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

export class BrandsRepo extends Context.Service<
  BrandsRepo,
  {
    readonly find: (
      id: BrandId,
    ) => Effect.Effect<Option.Option<Brand>, SqlError>
    readonly get: (
      id: BrandId,
    ) => Effect.Effect<Brand, BrandNotFound | SqlError>
    readonly list: Effect.Effect<ReadonlyArray<Brand>, SqlError>
    readonly insert: (brand: BrandInsert) => Effect.Effect<Brand, SqlError>
    readonly update: (
      id: BrandId,
      patch: BrandUpdate,
    ) => Effect.Effect<Brand, BrandNotFound | SqlError>
    readonly remove: (
      id: BrandId,
    ) => Effect.Effect<Brand, BrandNotFound | SqlError>
  }
>()("@digital-shelf/core/Catalog/repositories/BrandsRepo", {
  make: Effect.gen(function* () {
    // Queries resolve the transaction's fiber-local connection through this same Db.
    const db = yield* Db

    const find = Effect.fn("BrandsRepo.find", { level: "Debug" })(function* (
      id: BrandId,
    ) {
      return yield* one(
        yield* query(db.select().from(brands).where(eq(brands.id, id))),
      )
    })

    const get = (id: BrandId) => find(id).pipe(orNotFound(id))

    const list = Effect.fn("BrandsRepo.list", { level: "Debug" })(function* () {
      return yield* all(
        yield* query(
          db
            .select()
            .from(brands)
            .orderBy(asc(brands.name), asc(brands.createdAt)),
        ),
      )
    })()

    const insert = Effect.fn("BrandsRepo.insert", { level: "Debug" })(
      function* (brand: BrandInsert) {
        return yield* exactlyOne(
          yield* query(db.insert(brands).values(toRow(brand)).returning()),
        )
      },
    )

    const update = Effect.fn("BrandsRepo.update", { level: "Debug" })(
      function* (id: BrandId, patch: BrandUpdate) {
        const values = toPatch(patch)

        if (Object.keys(values).length === 0) return yield* get(id)

        return yield* one(
          yield* query(
            db.update(brands).set(values).where(eq(brands.id, id)).returning(),
          ),
        ).pipe(orNotFound(id))
      },
    )

    /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
    const remove = Effect.fn("BrandsRepo.remove", { level: "Debug" })(
      function* (id: BrandId) {
        return yield* one(
          yield* query(db.delete(brands).where(eq(brands.id, id)).returning()),
        ).pipe(orNotFound(id))
      },
    )

    return { find, get, list, insert, update, remove } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
