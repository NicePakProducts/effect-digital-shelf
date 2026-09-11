import {
  DuplicateVariantName,
  VariantNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import {
  Variant,
  VariantInsert,
  VariantUpdate,
} from "@digital-shelf/domain/Catalog/Variant"
import {
  type ProductId,
  type VariantId,
} from "@digital-shelf/domain/Shared/Ids"
import { variants } from "@digital-shelf/domain/Sql/Catalog"
import { and, asc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { onUniqueViolation, query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Variant rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `VariantNotFound`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(Variant)

const all = Rows.decodeAll(Variant)

const exactlyOne = Rows.decodeOne(Variant)

const toRow = Rows.encode(VariantInsert)

const toPatch = Rows.encode(VariantUpdate)

const orNotFound =
  (id: VariantId) =>
  <R>(
    self: Effect.Effect<Option.Option<Variant>, SqlError, R>,
  ): Effect.Effect<Variant, VariantNotFound | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new VariantNotFound({ variantId: id })),
        onSome: Effect.succeed,
      }),
    )

export const find = Effect.fn("VariantsRepo.find", { level: "Debug" })(
  function* (id: VariantId) {
    const db = yield* Db

    return yield* one(
      yield* query(db.select().from(variants).where(eq(variants.id, id))),
    )
  },
)

export const get = (id: VariantId) => find(id).pipe(orNotFound(id))

export type Filter = { productId?: ProductId }

export const list = Effect.fn("VariantsRepo.list", { level: "Debug" })(
  function* (filter: Filter = {}) {
    const db = yield* Db

    return yield* all(
      yield* query(
        db
          .select()
          .from(variants)
          .where(
            and(
              filter.productId === undefined
                ? undefined
                : eq(variants.productId, filter.productId),
            ),
          )
          .orderBy(asc(variants.name), asc(variants.createdAt)),
      ),
    )
  },
)

export const insert = Effect.fn("VariantsRepo.insert", { level: "Debug" })(
  function* (variant: VariantInsert) {
    const db = yield* Db

    return yield* exactlyOne(
      yield* query(db.insert(variants).values(toRow(variant)).returning()).pipe(
        onUniqueViolation(
          "variants_product_id_name",
          () =>
            new DuplicateVariantName({
              productId: variant.productId,
              name: variant.name,
            }),
        ),
      ),
    )
  },
)

export const update = Effect.fn("VariantsRepo.update", { level: "Debug" })(
  function* (id: VariantId, patch: VariantUpdate) {
    const existing = yield* get(id)
    const values = toPatch(patch)

    if (Object.keys(values).length === 0) return existing
    const db = yield* Db

    return yield* one(
      yield* query(
        db.update(variants).set(values).where(eq(variants.id, id)).returning(),
      ).pipe(
        onUniqueViolation(
          "variants_product_id_name",
          () =>
            new DuplicateVariantName({
              productId: patch.productId ?? existing.productId,
              name: patch.name ?? existing.name,
            }),
        ),
      ),
    ).pipe(orNotFound(id))
  },
)

/** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
export const remove = Effect.fn("VariantsRepo.remove", { level: "Debug" })(
  function* (id: VariantId) {
    const db = yield* Db

    return yield* one(
      yield* query(db.delete(variants).where(eq(variants.id, id)).returning()),
    ).pipe(orNotFound(id))
  },
)
