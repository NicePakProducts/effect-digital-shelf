import { ProductsErrors } from "@app/core/products"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { ProductsTable } from "@app/db/schema/products"
import { ProductVariants } from "@app/core/products/variants"
import { Cascade } from "@app/core/cascade"
import { ProductsRepo } from "../../src/products/repository"
import { VariantsRepo } from "../../src/products/variants/repository"
import { query } from "@app/core/Sql/Errors"
import { describe, expect, it } from "@effect/vitest"
import { eq, sql } from "drizzle-orm"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as PostgresTest from "../layers/Postgres"
import * as DbTest from "../layers/Db"
import * as R2BucketTest from "../layers/R2Bucket"
import * as Features from "../layers/Features"
import { seed, rowsOf } from "../fixtures/Catalog"

const TestLayer = Features.CatalogLayer.pipe(
  Layer.provideMerge([PostgresTest.TestLayer, R2BucketTest.TestLayer]),
)

const insertionWaits = (
  remaining: number,
): Effect.Effect<boolean, SqlError, Db> =>
  Effect.gen(function* () {
    const db = yield* Db

    const rows = rowsOf(
      yield* query(
        db.execute(
          sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like 'insert into "variants"%'`,
        ),
      ),
    )

    if (
      Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ waiting: Schema.Number })),
      )(rows).some((row) => row.waiting === 1)
    )
      return true

    if (remaining === 0) return false
    yield* Effect.promise(
      () => new Promise((resolve) => setTimeout(resolve, 20)),
    )

    return yield* insertionWaits(remaining - 1)
  })

describe.skipIf(PostgresTest.url === undefined)(
  "ProductVariants authoritative parent FK",
  () => {
    it.layer(TestLayer, { timeout: "60 seconds" })(
      "real repositories",
      (it) => {
        it.effect(
          "maps deletion after the preliminary parent read, while the insert waits on the deleting transaction",
          () =>
            Effect.gen(function* () {
              yield* DbTest.reset
              const c = yield* seed()
              const db = yield* Db
              const deleted = yield* Deferred.make<void>()
              const commit = yield* Deferred.make<void>()

              const deletion = yield* Effect.forkChild(
                db.transaction(() =>
                  Effect.gen(function* () {
                    yield* query(
                      db
                        .delete(ProductsTable)
                        .where(eq(ProductsTable.id, c.productId)),
                    )
                    yield* Deferred.succeed(deleted, undefined)
                    yield* Deferred.await(commit)
                  }),
                ),
              )

              yield* Deferred.await(deleted)

              // layerNoDeps is assembled only with real repositories, never substitutes.
              const variants = yield* ProductVariants.Service.pipe(
                Effect.provide(
                  ProductVariants.layerNoDeps.pipe(
                    Layer.provide([
                      ProductsRepo.layer,
                      VariantsRepo.layer,
                      Cascade.layer,
                    ]),
                  ),
                ),
              )

              const insertion = yield* Effect.forkChild(
                Effect.flip(
                  variants.create({
                    productId: c.productId,
                    name: "Racing variant",
                  }),
                ),
              )

              expect(yield* insertionWaits(250)).toBe(true)
              yield* Deferred.succeed(commit, undefined)
              yield* Fiber.join(deletion)
              expect(yield* Fiber.join(insertion)).toEqual(
                new ProductsErrors.NotFound({ productId: c.productId }),
              )
              expect(yield* variants.list({ productId: c.productId })).toEqual(
                [],
              )
            }),
        )
      },
    )
  },
)
