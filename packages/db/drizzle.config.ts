/// <reference types="node" />
import { defineConfig, type Config } from "drizzle-kit"
import { env } from "node:process"

// This package owns table definitions and generated SQL.
// Migrations are append-only: preserve the initial migration and generate
// each schema change with `bun run db:generate --name <change>`. Apply pending
// migrations with `bun run db:migrate` over the direct DATABASE_URL.
const config = {
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
} satisfies Config

export default defineConfig(
  env.DATABASE_URL
    ? { ...config, dbCredentials: { url: env.DATABASE_URL } }
    : config,
)
