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
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
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

export type Filter = { brandId?: BrandId }

export class ProductsRepo extends Context.Service<
  ProductsRepo,
  {
    readonly find: (
      id: ProductId,
    ) => Effect.Effect<Option.Option<Product>, SqlError>
    readonly get: (
      id: ProductId,
    ) => Effect.Effect<Product, ProductNotFound | SqlError>
    readonly list: (
      filter?: Filter,
    ) => Effect.Effect<ReadonlyArray<Product>, SqlError>
    readonly insert: (
      product: ProductInsert,
    ) => Effect.Effect<Product, SqlError>
    readonly update: (
      id: ProductId,
      patch: ProductUpdate,
    ) => Effect.Effect<Product, ProductNotFound | SqlError>
    readonly remove: (
      id: ProductId,
    ) => Effect.Effect<Product, ProductNotFound | SqlError>
  }
>()("@digital-shelf/core/Catalog/repositories/ProductsRepo", {
  make: Effect.gen(function* () {
    const db = yield* Db

    const find = Effect.fn("ProductsRepo.find", { level: "Debug" })(function* (
      id: ProductId,
    ) {
      return yield* one(
        yield* query(db.select().from(products).where(eq(products.id, id))),
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

    const insert = Effect.fn("ProductsRepo.insert", { level: "Debug" })(
      function* (product: ProductInsert) {
        return yield* exactlyOne(
          yield* query(db.insert(products).values(toRow(product)).returning()),
        )
      },
    )

    const update = Effect.fn("ProductsRepo.update", { level: "Debug" })(
      function* (id: ProductId, patch: ProductUpdate) {
        const values = toPatch(patch)

        if (Object.keys(values).length === 0) return yield* get(id)

        return yield* one(
          yield* query(
            db
              .update(products)
              .set(values)
              .where(eq(products.id, id))
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
            db.delete(products).where(eq(products.id, id)).returning(),
          ),
        ).pipe(orNotFound(id))
      },
    )

    return { find, get, list, insert, update, remove } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
