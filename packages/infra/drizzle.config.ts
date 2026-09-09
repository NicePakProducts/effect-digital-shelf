import { defineConfig } from "drizzle-kit"

// Table definitions live in core; this package owns the generated SQL that
// Alchemy's `Cloudflare.D1.Database({ migrations })` applies on deploy.
//
// Until the first production deploy, migrations are regenerated, not
// appended: delete the folder and run `pnpm db:generate --name initial`.
//
// After that, never let drizzle-kit emit a "recreate table" migration for a
// table that is a cascade parent: on D1 `PRAGMA foreign_keys=OFF` is a no-op,
// so the `DROP TABLE` it wraps cascade-deletes every child row. See
// docs/adr/0001-cascade-by-d1-foreign-keys.md.
export default defineConfig({
  dialect: "sqlite",
  schema: "../core/src/Sql/schema/index.ts",
  out: "./src/Sql/migrations",
})
