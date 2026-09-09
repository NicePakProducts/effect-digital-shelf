import type {
  EffectDrizzleQueryError,
  QueryEffectHKTBase,
} from "drizzle-orm/effect-core"
import type { PgQueryResultHKT } from "drizzle-orm/pg-core"
import type { PgEffectDatabase } from "drizzle-orm/pg-core/effect"
import type { Assume } from "drizzle-orm/utils"
import * as Context from "effect/Context"

/**
 * The Drizzle database every repository queries. Typed by the driver-agnostic
 * base so one tag holds both the Postgres database infra builds per request
 * or Workflow step over Hyperdrive and the PGlite database core's tests build
 * (test/layers/Db.ts): the two drivers' `EffectPgDatabase` classes are
 * structurally identical, and the driver is chosen where the layer is built.
 *
 * `db.transaction` is `SqlClient.withTransaction` underneath. The reserved
 * connection travels in the fiber's services, so repository queries issued
 * inside a feature's transaction join it without a handle being threaded.
 */
export interface QueryEffectHKT extends QueryEffectHKTBase {
  readonly error: EffectDrizzleQueryError
  readonly context: never
}

export interface QueryResultHKT extends PgQueryResultHKT {
  type: readonly Assume<this["row"], object>[]
}

export type Database = PgEffectDatabase<QueryEffectHKT, QueryResultHKT>

export class Db extends Context.Service<Db, Database>()(
  "@digital-shelf/core/Sql/Db",
) {}
