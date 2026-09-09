import { defineConfig } from "drizzle-kit"

// Table definitions live in domain (`Sql/`, ADR 0002); this package owns the
// generated SQL. Migrations are applied to PlanetScale from CI over the
// direct connection, never through Hyperdrive (see the Postgres research
// ticket on the map).
//
// Until the first production deploy, migrations are regenerated, not
// appended: delete the folder and run `pnpm db:generate --name initial`.
export default defineConfig({
  dialect: "postgresql",
  schema: "../domain/src/Sql/index.ts",
  out: "./src/Sql/migrations",
})
