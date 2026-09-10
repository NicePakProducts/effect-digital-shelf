import { describe, expect, it } from "@effect/vitest"
import { Db } from "@digital-shelf/core/Sql/Db"
import * as Adapter from "@digital-shelf/infra/Adapters/Db"
import { sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

// Only a disposable CI/local database; never read DATABASE_URL here.
const url = process.env.DIGITAL_SHELF_TEST_POSTGRES_URL

describe.skipIf(url === undefined)("Db adapter on PostgreSQL", () => {
  it.layer(Adapter.layer(Redacted.make(url ?? "")), { timeout: "30 seconds" })(
    "scoped pool",
    (it) => {
      it.effect(
        "selects and rolls back a Drizzle transaction without a project schema",
        () =>
          Effect.gen(function* () {
            const db = yield* Db
            expect(yield* db.execute(sql`SELECT 1 AS one`)).toEqual([
              { one: 1 },
            ])
            // The pool has one connection. This table is session-local and disappears
            // when the layer closes; no shared schema or project data is touched.
            yield* db.execute(
              sql`CREATE TEMP TABLE infra_rollback_probe (id integer)`,
            )
            yield* db.transaction(() =>
              db.execute(sql`INSERT INTO infra_rollback_probe VALUES (1)`),
            )
            const failed = yield* Effect.flip(
              db.transaction(() =>
                Effect.gen(function* () {
                  yield* db.execute(
                    sql`INSERT INTO infra_rollback_probe VALUES (2)`,
                  )
                  // Query through the outer Db tag to prove fiber-scoped participation.
                  const sameDb = yield* Db
                  expect(
                    yield* sameDb.execute(
                      sql`SELECT id FROM infra_rollback_probe ORDER BY id`,
                    ),
                  ).toEqual([{ id: 1 }, { id: 2 }])
                  return yield* Effect.fail("rollback probe")
                }),
              ),
            )
            expect(failed).toBe("rollback probe")
            expect(
              yield* db.execute(sql`SELECT id FROM infra_rollback_probe`),
            ).toEqual([{ id: 1 }])
            expect(yield* db.execute(sql`SELECT 1 AS one`)).toEqual([
              { one: 1 },
            ])
          }),
      )
    },
  )
})
