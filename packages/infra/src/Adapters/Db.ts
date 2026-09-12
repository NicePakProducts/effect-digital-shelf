import { Db } from "@digital-shelf/core/Sql/Db"
import * as Postgres from "alchemy/SQL/Postgres"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"

/**
 * The Drizzle database, built once per isolate over Alchemy's per-invocation
 * Postgres client. Alchemy memoises the client on the invocation's scope: an
 * invocation's first statement opens its pool over Hyperdrive and closing the
 * scope ends it, which is the one connection lifecycle workerd allows, since a
 * socket never outlives the request that opened it. Drizzle itself is a real
 * instance, so subqueries and fragments compose on plain values; only the SQL
 * client underneath resolves per invocation. Building the layer performs no I/O.
 */
export const layer = <E, R>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
): Layer.Layer<Db, never, Exclude<R, never>> =>
  Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provide(
      Postgres.PostgresLayer({
        url: connectionString,
        // Cloudflare allows six concurrent outbound connections per invocation.
        maxConnections: 5,
        // Hyperdrive connects in milliseconds; a laptop reaching the origin
        // directly takes seconds, and a fresh pool opens several at once.
        connectTimeout: "20 seconds",
      }),
    ),
  )
