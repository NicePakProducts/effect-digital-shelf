import { describe, expect, it } from "@effect/vitest"
import { Db } from "@digital-shelf/core/Sql/Db"
import * as Adapter from "@digital-shelf/infra/Adapters/Db"
import { eq, inArray, sql } from "drizzle-orm"
import { integer, pgTable } from "drizzle-orm/pg-core"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

// Only a disposable CI/local database; never read DATABASE_URL here.
const url = process.env.DIGITAL_SHELF_TEST_POSTGRES_URL

/** Drizzle types `execute` as the rows; the pg driver hands back its Result. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Drizzle's execute type differs from the pg driver's Result at this boundary.
const rowsOf = (result: unknown): ReadonlyArray<unknown> =>
  Array.isArray(result)
    ? result
    : // SAFETY: Non-array execute results come from pg, whose Result owns rows.
      (result as { readonly rows: ReadonlyArray<unknown> }).rows

describe.skipIf(url === undefined)("Db adapter on PostgreSQL", () => {
  it.layer(Adapter.layer(Effect.succeed(Redacted.make(url ?? ""))), {
    timeout: "30 seconds",
  })("pool per invocation", (it) => {
    // A table object over a session-local TEMP table, so the probe needs no
    // project schema and vanishes with the invocation's connection.
    const probe = pgTable("infra_subquery_probe", {
      id: integer("id").notNull(),
      parent: integer("parent").notNull(),
    })

    it.effect(
      "composes subqueries and aliases on the once-built Drizzle instance",
      () =>
        Effect.gen(function* () {
          const db = yield* Db
          yield* db.execute(
            sql`CREATE TEMP TABLE infra_subquery_probe (id integer, parent integer)`,
          )
          yield* db.insert(probe).values([
            { id: 1, parent: 10 },
            { id: 2, parent: 20 },
            { id: 3, parent: 10 },
          ])

          // The shapes ScrapesRepo.deleteExpired and ParentsRepo.cadenceDue use:
          // a builder as an IN subquery, and an aliased subquery as a source.
          const doomed = db
            .select({ id: probe.id })
            .from(probe)
            .where(eq(probe.parent, 10))

          const deleted = yield* db
            .delete(probe)
            .where(inArray(probe.id, doomed))
            .returning({ id: probe.id })

          expect(deleted.map((row) => row.id).sort((a, b) => a - b)).toEqual([
            1, 3,
          ])

          const last = db.select({ id: probe.id }).from(probe).as("last")
          expect(yield* db.select({ id: last.id }).from(last)).toEqual([
            { id: 2 },
          ])
        }).pipe(Effect.scoped),
    )

    it.effect("gives each invocation scope its own connection", () =>
      Effect.gen(function* () {
        const db = yield* Db

        const backend = Effect.scoped(
          Effect.map(
            db.execute(sql`SELECT pg_backend_pid() AS pid`),
            (result) => rowsOf(result)[0],
          ),
        )

        expect(yield* backend).not.toEqual(yield* backend)
      }),
    )

    it.effect(
      "selects and rolls back a Drizzle transaction without a project schema",
      () =>
        Effect.gen(function* () {
          const db = yield* Db
          expect(rowsOf(yield* db.execute(sql`SELECT 1 AS one`))).toEqual([
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
                  rowsOf(
                    yield* sameDb.execute(
                      sql`SELECT id FROM infra_rollback_probe ORDER BY id`,
                    ),
                  ),
                ).toEqual([{ id: 1 }, { id: 2 }])

                return yield* Effect.fail("rollback probe")
              }),
            ),
          )

          expect(failed).toBe("rollback probe")
          expect(
            rowsOf(yield* db.execute(sql`SELECT id FROM infra_rollback_probe`)),
          ).toEqual([{ id: 1 }])
          expect(rowsOf(yield* db.execute(sql`SELECT 1 AS one`))).toEqual([
            { one: 1 },
          ])
        }).pipe(Effect.scoped),
    )
  })
})
