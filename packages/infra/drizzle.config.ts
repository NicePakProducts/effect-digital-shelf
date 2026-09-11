/// <reference types="node" />
import { defineConfig } from "drizzle-kit"
import { env } from "node:process"

// Table definitions live in domain (`Sql/`, ADR 0002); this package owns the
// generated SQL. Migrations are applied to PlanetScale from CI over the
// direct connection, never through Hyperdrive (see the Postgres research
// ticket on the map).
//
// Migrations are append-only: preserve the initial migration and generate
// each schema change with `pnpm db:generate --name <change>`. Apply pending
// migrations with `pnpm db:migrate` over the direct DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "../domain/src/Sql/index.ts",
  out: "./src/Sql/migrations",
  ...(env.DATABASE_URL ? { dbCredentials: { url: env.DATABASE_URL } } : {}),
})
