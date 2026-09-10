import type { AnyPgColumn } from "drizzle-orm/pg-core"
import { sql, type SQL } from "drizzle-orm"
import * as DateTime from "effect/DateTime"

/**
 * Keyset pagination over `(created_at, id)`, newest first. The pair is
 * compared as a row so the two columns are one ordering, which the
 * `created_at` indexes serve; both sides are cast so Postgres never has to
 * guess a parameter's type inside a row comparison.
 */
export interface Cursor {
  readonly createdAt: DateTime.Utc
  readonly id: string
}

/** `(created_at, id) < (cursor)`, or nothing when the page is the first. */
export const beforeCursor = (
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  cursor: Cursor | undefined,
): SQL | undefined =>
  cursor === undefined
    ? undefined
    : sql`(${createdAt}, ${id}) < (${DateTime.formatIso(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`
