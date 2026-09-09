import { sql, type SQL } from "drizzle-orm"
import {
  check,
  integer,
  text,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core"

/**
 * Column conventions shared by every table.
 *
 * - Ids are opaque TEXT minted by core with `crypto.randomUUID()`. No DB
 *   default: a Scrape's id must exist before its Execution is created, and
 *   tests supply fixed ids. Migrated InstantDB UUIDs fit the same column.
 * - Timestamps are INTEGER epoch milliseconds, stamped by core from the
 *   Effect `Clock`; the DB default is a fallback only. SQLite has no
 *   `ON UPDATE`, so `updated_at` is always written by core.
 * - Booleans are INTEGER 0/1 with a CHECK; unions are TEXT with a CHECK
 *   listing the literals (Drizzle's `enum` option is type-only).
 * - JSON is TEXT guarded by `json_valid`; `domain` schemas decode it.
 * - Absent values are NULL, never empty strings or zeros.
 */

export const id = () => text("id").primaryKey()

const epochMs = sql`(unixepoch() * 1000)`

export const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" }).notNull().default(epochMs)

export const updatedAt = () =>
  integer("updated_at", { mode: "timestamp_ms" }).notNull().default(epochMs)

/** A nullable epoch-ms timestamp: NULL means "has not happened yet". */
export const timestamp = (name: string) =>
  integer(name, { mode: "timestamp_ms" })

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const boolean = (name: string) =>
  integer(name, { mode: "boolean" }).notNull()

export const booleanCheck = (table: string, column: AnySQLiteColumn) =>
  check(`${table}_${column.name}_boolean`, sql`${column} IN (0, 1)`)

export const literals = <const T extends readonly [string, ...string[]]>(
  name: string,
  values: T,
) => text(name, { enum: values })

/** `column IN ('a', 'b')` with the literals inlined, never bound. */
export const inLiterals = (
  column: AnySQLiteColumn,
  values: readonly string[],
): SQL =>
  sql`${column} IN (${sql.join(
    values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
    sql`, `,
  )})`

export const literalsCheck = (
  table: string,
  column: AnySQLiteColumn,
  values: readonly string[],
) => check(`${table}_${column.name}_literal`, inLiterals(column, values))

/** Like `literalsCheck` for a nullable column: NULL passes. */
export const nullableLiteralsCheck = (
  table: string,
  column: AnySQLiteColumn,
  values: readonly string[],
) =>
  check(
    `${table}_${column.name}_literal`,
    sql`${column} IS NULL OR ${inLiterals(column, values)}`,
  )

export const json = (name: string) => text(name, { mode: "json" })

export const jsonCheck = (table: string, column: AnySQLiteColumn) =>
  check(
    `${table}_${column.name}_json`,
    sql`${column} IS NULL OR json_valid(${column})`,
  )

export const nocase = (column: AnySQLiteColumn): SQL =>
  sql`${column} COLLATE NOCASE`
