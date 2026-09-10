import type { BrandId } from "@digital-shelf/domain/Shared/Ids"
import {
  Product,
  ProductInsert,
  ProductUpdate,
} from "@digital-shelf/domain/Catalog/Product"
import { ProductNotFound } from "@digital-shelf/domain/Catalog/Errors"
import type { ProductId } from "@digital-shelf/domain/Shared/Ids"
import { products } from "@digital-shelf/domain/Sql/Catalog"
import { and, asc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Product rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `ProductNotFound`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(Product)
const all = Rows.decodeAll(Product)
const exactlyOne = Rows.decodeOne(Product)
const toRow = Rows.encode(ProductInsert)
const toPatch = Rows.encode(ProductUpdate)

const orNotFound =
  (id: ProductId) =>
  <R>(
    self: Effect.Effect<Option.Option<Product>, SqlError, R>,
  ): Effect.Effect<Product, ProductNotFound | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new ProductNotFound({ productId: id })),
        onSome: Effect.succeed,
      }),
    )

export const find = Effect.fn("ProductsRepo.find")(function* (id: ProductId) {
  const db = yield* Db
  return yield* one(
    yield* query(db.select().from(products).where(eq(products.id, id))),
  )
})

export const get = (id: ProductId) => find(id).pipe(orNotFound(id))

export type Filter = { brandId?: BrandId }
export const list = Effect.fn("ProductsRepo.list")(function* (
  filter: Filter = {},
) {
  const db = yield* Db
  return yield* all(
    yield* query(
      db
        .select()
        .from(products)
        .where(
          and(
            filter.brandId === undefined
              ? undefined
              : eq(products.brandId, filter.brandId),
          ),
        )
        .orderBy(asc(products.name), asc(products.createdAt)),
    ),
  )
})

export const insert = Effect.fn("ProductsRepo.insert")(function* (
  product: ProductInsert,
) {
  const db = yield* Db
  return yield* exactlyOne(
    yield* query(db.insert(products).values(toRow(product)).returning()),
  )
})

export const update = Effect.fn("ProductsRepo.update")(function* (
  id: ProductId,
  patch: ProductUpdate,
) {
  const values = toPatch(patch)
  if (Object.keys(values).length === 0) return yield* get(id)
  const db = yield* Db
  return yield* one(
    yield* query(
      db.update(products).set(values).where(eq(products.id, id)).returning(),
    ),
  ).pipe(orNotFound(id))
})

/** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
export const remove = Effect.fn("ProductsRepo.remove")(function* (
  id: ProductId,
) {
  const db = yield* Db
  return yield* one(
    yield* query(db.delete(products).where(eq(products.id, id)).returning()),
  ).pipe(orNotFound(id))
})
