import * as PgliteClient from "@effect/sql-pglite/PgliteClient"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import * as Sql from "@digital-shelf/domain/Sql/index"
import { PGlite } from "@electric-sql/pglite"
import { pushSchema } from "drizzle-kit/api-postgres"
import { sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-pglite"
import { drizzle } from "drizzle-orm/pglite"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * A Postgres in this process for core's tests: PGlite with the schema pushed
 * straight from the domain tables (ADR 0002), then the Effect Drizzle
 * database over the same instance. One PGlite per `it.layer` block, since
 * booting Postgres is the slow part; `reset` empties the catalog between
 * tests and the cascade takes the rest. Infra's tests prove the committed
 * migration separately.
 */
const boot = Effect.promise(async () => {
  const pglite = new PGlite()
  const { apply } = await pushSchema(Sql, drizzle({ client: pglite }))
  await apply()
  return pglite
})

export const layerTest: Layer.Layer<
  Db | PgliteClient.PgliteClient | SqlClient.SqlClient,
  SqlError
> = Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
  Layer.provideMerge(
    PgliteClient.layerFrom(
      Effect.flatMap(boot, (liveClient) =>
        PgliteClient.fromClient({ liveClient }),
      ),
    ),
  ),
)

export const reset: Effect.Effect<void, SqlError, Db> = Effect.gen(
  function* () {
    const db = yield* Db
    yield* query(db.execute(sql`TRUNCATE brands, retailers CASCADE`))
  },
)

export const resetAuth: Effect.Effect<void, SqlError, Db> = Effect.gen(
  function* () {
    const db = yield* Db
    yield* query(
      db.execute(
        sql`TRUNCATE "user", "session", "verification", "account" CASCADE`,
      ),
    )
  },
)
