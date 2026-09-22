import { Product } from "@app/schema/product"
import * as Data from "effect/Data"
import type { BrandId, ProductId } from "@app/schema/ids"
import { ProductsTable } from "@app/db/schema/products"
import { and, asc, eq } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { query } from "../Sql/Errors"
import * as Rows from "../Sql/Rows"
/**
 * Product.Info rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `MissingProduct`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(Product.Info)

const all = Rows.decodeAll(Product.Info)

const exactlyOne = Rows.decodeOne(Product.Info)

const toRow = Rows.encode(Product.Insert)

const toPatch = Rows.encode(Product.UpdateRow)

const orNotFound =
  (id: ProductId) =>
  <R>(
    self: Effect.Effect<Option.Option<Product.Info>, SqlError, R>,
  ): Effect.Effect<Product.Info, MissingProduct | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new MissingProduct({ productId: id })),
        onSome: Effect.succeed,
      }),
    )

export type Filter = { brandId?: BrandId }

export * as ProductsRepo from "./repository"

export interface Interface {
  readonly find: (
    id: ProductId,
  ) => Effect.Effect<Option.Option<Product.Info>, SqlError>
  readonly get: (
    id: ProductId,
  ) => Effect.Effect<Product.Info, MissingProduct | SqlError>
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Product.Info>, SqlError>
  readonly insert: (
    product: Product.Insert,
  ) => Effect.Effect<Product.Info, SqlError>
  readonly update: (
    id: ProductId,
    patch: Product.UpdateRow,
  ) => Effect.Effect<Product.Info, MissingProduct | SqlError>
  readonly remove: (
    id: ProductId,
  ) => Effect.Effect<Product.Info, MissingProduct | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/products/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const find = Effect.fn("ProductsRepo.find", { level: "Debug" })(function* (
    id: ProductId,
  ) {
    return yield* one(
      yield* query(
        db.select().from(ProductsTable).where(eq(ProductsTable.id, id)),
      ),
    )
  })

  const get = (id: ProductId) => find(id).pipe(orNotFound(id))

  const list = Effect.fn("ProductsRepo.list", { level: "Debug" })(function* (
    filter: Filter = {},
  ) {
    return yield* all(
      yield* query(
        db
          .select()
          .from(ProductsTable)
          .where(
            and(
              filter.brandId === undefined
                ? undefined
                : eq(ProductsTable.brandId, filter.brandId),
            ),
          )
          .orderBy(asc(ProductsTable.name), asc(ProductsTable.createdAt)),
      ),
    )
  })

  const insert = Effect.fn("ProductsRepo.insert", { level: "Debug" })(
    function* (product: Product.Insert) {
      return yield* exactlyOne(
        yield* query(
          db.insert(ProductsTable).values(toRow(product)).returning(),
        ),
      )
    },
  )

  const update = Effect.fn("ProductsRepo.update", { level: "Debug" })(
    function* (id: ProductId, patch: Product.UpdateRow) {
      const values = toPatch(patch)

      if (Object.keys(values).length === 0) return yield* get(id)

      return yield* one(
        yield* query(
          db
            .update(ProductsTable)
            .set(values)
            .where(eq(ProductsTable.id, id))
            .returning(),
        ),
      ).pipe(orNotFound(id))
    },
  )

  /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
  const remove = Effect.fn("ProductsRepo.remove", { level: "Debug" })(
    function* (id: ProductId) {
      return yield* one(
        yield* query(
          db.delete(ProductsTable).where(eq(ProductsTable.id, id)).returning(),
        ),
      ).pipe(orNotFound(id))
    },
  )

  return { find, get, list, insert, update, remove } as const
})

export const layer = Layer.effect(Service, make)

export class MissingProduct extends Data.TaggedError("MissingProduct")<{
  readonly productId: ProductId
}> {}
