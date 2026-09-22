import * as Data from "effect/Data"
import { Brand } from "@app/schema/brand"
import type { BrandId } from "@app/schema/ids"
import { BrandsTable } from "@app/db/schema/brands"
import { asc, eq } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { query } from "../Sql/Errors"
import * as Rows from "../Sql/Rows"
/**
 * Brand rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `MissingBrand`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(Brand.Info)

const all = Rows.decodeAll(Brand.Info)

const exactlyOne = Rows.decodeOne(Brand.Info)

const toRow = Rows.encode(Brand.Insert)

const toPatch = Rows.encode(Brand.UpdateRow)

const orNotFound =
  (id: BrandId) =>
  <R>(
    self: Effect.Effect<Option.Option<Brand.Info>, SqlError, R>,
  ): Effect.Effect<Brand.Info, MissingBrand | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new MissingBrand({ brandId: id })),
        onSome: Effect.succeed,
      }),
    )

export * as BrandsRepo from "./repository"

export interface Interface {
  readonly find: (
    id: BrandId,
  ) => Effect.Effect<Option.Option<Brand.Info>, SqlError>
  readonly get: (
    id: BrandId,
  ) => Effect.Effect<Brand.Info, MissingBrand | SqlError>
  readonly list: Effect.Effect<ReadonlyArray<Brand.Info>, SqlError>
  readonly insert: (brand: Brand.Insert) => Effect.Effect<Brand.Info, SqlError>
  readonly update: (
    id: BrandId,
    patch: Brand.UpdateRow,
  ) => Effect.Effect<Brand.Info, MissingBrand | SqlError>
  readonly remove: (
    id: BrandId,
  ) => Effect.Effect<Brand.Info, MissingBrand | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/brands/repository",
) {}

const make = Effect.gen(function* () {
  // Queries resolve the transaction's fiber-local connection through this same Db.
  const db = yield* Db

  const find = Effect.fn("BrandsRepo.find", { level: "Debug" })(function* (
    id: BrandId,
  ) {
    return yield* one(
      yield* query(db.select().from(BrandsTable).where(eq(BrandsTable.id, id))),
    )
  })

  const get = (id: BrandId) => find(id).pipe(orNotFound(id))

  const list = Effect.fn("BrandsRepo.list", { level: "Debug" })(function* () {
    return yield* all(
      yield* query(
        db
          .select()
          .from(BrandsTable)
          .orderBy(asc(BrandsTable.name), asc(BrandsTable.createdAt)),
      ),
    )
  })()

  const insert = Effect.fn("BrandsRepo.insert", { level: "Debug" })(function* (
    brand: Brand.Insert,
  ) {
    return yield* exactlyOne(
      yield* query(db.insert(BrandsTable).values(toRow(brand)).returning()),
    )
  })

  const update = Effect.fn("BrandsRepo.update", { level: "Debug" })(function* (
    id: BrandId,
    patch: Brand.UpdateRow,
  ) {
    const values = toPatch(patch)

    if (Object.keys(values).length === 0) return yield* get(id)

    return yield* one(
      yield* query(
        db
          .update(BrandsTable)
          .set(values)
          .where(eq(BrandsTable.id, id))
          .returning(),
      ),
    ).pipe(orNotFound(id))
  })

  /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
  const remove = Effect.fn("BrandsRepo.remove", { level: "Debug" })(function* (
    id: BrandId,
  ) {
    return yield* one(
      yield* query(
        db.delete(BrandsTable).where(eq(BrandsTable.id, id)).returning(),
      ),
    ).pipe(orNotFound(id))
  })

  return { find, get, list, insert, update, remove } as const
})

export const layer = Layer.effect(Service, make)

export class MissingBrand extends Data.TaggedError("MissingBrand")<{
  readonly brandId: BrandId
}> {}
