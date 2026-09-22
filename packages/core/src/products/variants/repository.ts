import { ProductVariant } from "@app/schema/product-variant"
import * as Schema from "effect/Schema"
import * as Predicate from "effect/Predicate"
import * as Data from "effect/Data"
import { type ProductId, VariantId } from "@app/schema/ids"
import { ProductVariantsTable } from "@app/db/schema/products"
import { and, asc, eq, inArray } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { onUniqueViolation, query } from "../../Sql/Errors"
import * as Rows from "../../Sql/Rows"
/**
 * ProductVariant.Info rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `MissingVariant`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(ProductVariant.Info)

const all = Rows.decodeAll(ProductVariant.Info)

const exactlyOne = Rows.decodeOne(ProductVariant.Info)

const toRow = Rows.encode(ProductVariant.Insert)

const toPatch = Rows.encode(ProductVariant.UpdateRow)

const orNotFound =
  (id: VariantId) =>
  <R>(
    self: Effect.Effect<Option.Option<ProductVariant.Info>, SqlError, R>,
  ): Effect.Effect<ProductVariant.Info, MissingVariant | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new MissingVariant({ variantId: id })),
        onSome: Effect.succeed,
      }),
    )

export type Filter = { productId?: ProductId }

export * as VariantsRepo from "./repository"

export interface Interface {
  readonly notInProduct: (
    productId: ProductId,
    variantIds: ReadonlyArray<VariantId>,
  ) => Effect.Effect<ReadonlyArray<VariantId>, SqlError>

  readonly find: (
    id: VariantId,
  ) => Effect.Effect<Option.Option<ProductVariant.Info>, SqlError>
  readonly get: (
    id: VariantId,
  ) => Effect.Effect<ProductVariant.Info, MissingVariant | SqlError>
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<ProductVariant.Info>, SqlError>
  readonly insert: (
    variant: ProductVariant.Insert,
  ) => Effect.Effect<ProductVariant.Info, SqlError | NameTaken | ParentMissing>
  readonly update: (
    id: VariantId,
    patch: ProductVariant.UpdateRow,
  ) => Effect.Effect<ProductVariant.Info, MissingVariant | SqlError | NameTaken>
  readonly remove: (
    id: VariantId,
  ) => Effect.Effect<ProductVariant.Info, MissingVariant | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/products/variants/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const notInProduct = Effect.fn("VariantsRepo.notInProduct", {
    level: "Debug",
  })(function* (productId: ProductId, variantIds: ReadonlyArray<VariantId>) {
    if (variantIds.length === 0) return []

    const rows = yield* Rows.decodeAll(Schema.Struct({ id: VariantId }))(
      yield* query(
        db
          .select({ id: ProductVariantsTable.id })
          .from(ProductVariantsTable)
          .where(
            and(
              eq(ProductVariantsTable.productId, productId),
              inArray(ProductVariantsTable.id, variantIds),
            ),
          ),
      ),
    )

    const valid = new Set(rows.map((row) => row.id))

    return variantIds.filter((id) => !valid.has(id))
  })

  const find = Effect.fn("VariantsRepo.find", { level: "Debug" })(function* (
    id: VariantId,
  ) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(ProductVariantsTable)
          .where(eq(ProductVariantsTable.id, id)),
      ),
    )
  })

  const get = (id: VariantId) => find(id).pipe(orNotFound(id))

  const list = Effect.fn("VariantsRepo.list", { level: "Debug" })(function* (
    filter: Filter = {},
  ) {
    return yield* all(
      yield* query(
        db
          .select()
          .from(ProductVariantsTable)
          .where(
            and(
              filter.productId === undefined
                ? undefined
                : eq(ProductVariantsTable.productId, filter.productId),
            ),
          )
          .orderBy(
            asc(ProductVariantsTable.name),
            asc(ProductVariantsTable.createdAt),
          ),
      ),
    )
  })

  const insert = Effect.fn("VariantsRepo.insert", { level: "Debug" })(
    function* (variant: ProductVariant.Insert) {
      return yield* exactlyOne(
        yield* query(
          db.insert(ProductVariantsTable).values(toRow(variant)).returning(),
        ).pipe(
          onUniqueViolation(
            "variants_product_id_name",
            () =>
              new NameTaken({
                productId: variant.productId,
                name: variant.name,
              }),
          ),
          Effect.catchTag(
            "SqlError",
            (error): Effect.Effect<never, SqlError | ParentMissing> => {
              const cause = error.reason.cause

              return Predicate.isTagged(error.reason, "ConstraintError") &&
                Predicate.isObject(cause) &&
                "code" in cause &&
                cause.code === "23503" &&
                "constraint" in cause &&
                cause.constraint === "variants_product_id_products_id_fkey"
                ? Effect.fail(
                    new ParentMissing({
                      productId: variant.productId,
                      cause: error,
                    }),
                  )
                : Effect.fail(error)
            },
          ),
        ),
      )
    },
  )

  const update = Effect.fn("VariantsRepo.update", { level: "Debug" })(
    function* (id: VariantId, patch: ProductVariant.UpdateRow) {
      const existing = yield* get(id)
      const values = toPatch(patch)

      if (Object.keys(values).length === 0) return existing

      return yield* one(
        yield* query(
          db
            .update(ProductVariantsTable)
            .set(values)
            .where(eq(ProductVariantsTable.id, id))
            .returning(),
        ).pipe(
          onUniqueViolation(
            "variants_product_id_name",
            () =>
              new NameTaken({
                productId: patch.productId ?? existing.productId,
                name: patch.name ?? existing.name,
              }),
          ),
        ),
      ).pipe(orNotFound(id))
    },
  )

  /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
  const remove = Effect.fn("VariantsRepo.remove", { level: "Debug" })(
    function* (id: VariantId) {
      return yield* one(
        yield* query(
          db
            .delete(ProductVariantsTable)
            .where(eq(ProductVariantsTable.id, id))
            .returning(),
        ),
      ).pipe(orNotFound(id))
    },
  )

  return { find, get, list, insert, update, remove, notInProduct } as const
})

export const layer = Layer.effect(Service, make)

export class MissingVariant extends Data.TaggedError("MissingVariant")<{
  readonly variantId: VariantId
}> {}

export class NameTaken extends Data.TaggedError("NameTaken")<{
  readonly productId: ProductId
  readonly name: string
}> {}

export class ParentMissing extends Data.TaggedError("ParentMissing")<{
  readonly productId: ProductId
  readonly cause: SqlError
}> {}
