import * as PgClient from "@effect/sql-pg/PgClient"
import { Db } from "@digital-shelf/core/Sql/Db"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import * as Layer from "effect/Layer"
import type * as Redacted from "effect/Redacted"

/** Build/provide inside each request or Workflow step, so its pool is scoped. */
export const layer = (url: Redacted.Redacted<string>) =>
  Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provide(PgClient.layer({ url, maxConnections: 1 })),
  )
