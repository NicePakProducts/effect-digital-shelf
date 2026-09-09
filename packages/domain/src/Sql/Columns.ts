import { sql, type SQL } from "drizzle-orm"
import { check, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core"

/**
 * Column conventions shared by every table.
 *
 * - Ids are `uuid`, minted in the app by `$defaultFn` when the insert omits
 *   them. Core passes an explicit id wherever it needs one before the insert
 *   (a Scrape's id names its Execution). Migrated InstantDB UUIDs fit.
 * - Timestamps are `timestamptz`; `created_at` and `updated_at` default to
 *   `now()` and `updated_at` is rewritten by Drizzle on every update.
 * - Stable literal sets are Postgres enums (Enums.ts); evolving ones are text
 *   with a CHECK so a value can be retired without recreating a type.
 * - JSON is `jsonb`. Absent values are NULL, never empty strings or zeros.
 */

export const id = () =>
  uuid("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID())

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date" })

export const createdAt = () => timestamptz("created_at").notNull().defaultNow()

export const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    // Drizzle's `mode: "date"` columns take a JS Date; the entity refines it to DateTime.
    // @effect-diagnostics-next-line globalDate:off
    .$onUpdate(() => new Date())

/** A nullable timestamptz: NULL means "has not happened yet". */
export const at = (name: string) => timestamptz(name)

export const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** `column IN ('a', 'b')` with the literals inlined, never bound. */
export const inLiterals = (
  column: AnyPgColumn,
  values: readonly string[],
): SQL =>
  sql`${column} IN (${sql.join(
    values.map((value) => sql.raw(`'${value.replaceAll("'", "''")}'`)),
    sql`, `,
  )})`

/** Like a literals CHECK but for a nullable column: NULL passes. */
export const nullableLiteralsCheck = (
  table: string,
  column: AnyPgColumn,
  values: readonly string[],
) =>
  check(
    `${table}_${column.name}_literal`,
    sql`${column} IS NULL OR ${inLiterals(column, values)}`,
  )
