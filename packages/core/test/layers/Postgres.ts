import * as PgClient from "@effect/sql-pg/PgClient"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import * as Sql from "@digital-shelf/domain/Sql/index"
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres"
import { sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * A real PostgreSQL for the tests PGlite cannot host: those that need two
 * transactions to overlap on two connections. `TEST_DATABASE_URL` names a
 * disposable database whose `public` schema this layer drops and recreates
 * from the domain tables (ADR 0002) on boot, so it must hold throwaway data
 * only: the CI workflow's service container, or a local instance started for
 * the purpose. A test file that needs it skips itself when the variable is
 * unset, and a skip is reported as one, never counted as the proof.
 */
export const url = process.env.TEST_DATABASE_URL

const schema = Effect.gen(function* () {
  const db = yield* Db
  const statements = yield* Effect.promise(async () =>
    generateMigration(
      await generateDrizzleJson({}),
      await generateDrizzleJson(Sql),
    ),
  )
  yield* query(db.execute(sql`DROP SCHEMA public CASCADE`))
  yield* query(db.execute(sql`CREATE SCHEMA public`))
  for (const statement of statements)
    yield* query(db.execute(sql.raw(statement)))
  return db
})

export const layerTest: Layer.Layer<
  Db | PgClient.PgClient | SqlClient.SqlClient,
  SqlError
> = Layer.effect(
  Db,
  Effect.flatMap(PgDrizzle.makeWithDefaults(), (db) =>
    Effect.provideService(schema, Db, db),
  ),
).pipe(
  Layer.provideMerge(
    PgClient.layer({ url: Redacted.make(url ?? ""), maxConnections: 4 }),
  ),
)
