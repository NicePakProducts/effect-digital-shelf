import * as DateTime from "effect/DateTime"
import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

/**
 * Cursor pagination shared by the Scrape and Extraction lists. Pages are
 * newest first over the `(createdAt, id)` keyset, and the cursor names the
 * last row of the page before: `<createdAtMillis>:<id>`. Its shape is checked
 * here, so a malformed cursor is a decode failure (400) rather than a
 * silently empty page; the handler turns the checked string into the keyset.
 * The millis are capped at thirteen digits, which reach the year 2286, so
 * every cursor that decodes names an instant the clock and the database hold.
 */
export const Cursor = Schema.String.check(
  Schema.isPattern(
    /^\d{1,13}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    {
      identifier: "Cursor",
      description: "a page cursor, `<createdAtMillis>:<id>`",
    },
  ),
)
export type Cursor = typeof Cursor.Type

/**
 * One page holds 1 to 100 rows; a request that says nothing gets
 * `defaultLimit`. The bound is a pattern over the query string rather than a
 * numeric range so the contract carries it into the OpenAPI document.
 */
export const Limit = Schema.String.check(
  Schema.isPattern(/^(100|[1-9][0-9]?)$/, {
    identifier: "Limit",
    description: "rows per page, 1 to 100; 50 when omitted",
  }),
).pipe(Schema.decodeTo(Schema.Int, SchemaTransformation.numberFromString))

export const defaultLimit = 50

/** The `(createdAt, id)` keyset a cursor names. */
export interface Keyset {
  readonly createdAt: DateTime.Utc
  readonly id: string
}

export const parseCursor = (cursor: Cursor): Keyset => {
  const separator = cursor.indexOf(":")
  return {
    createdAt: DateTime.makeUnsafe(Number(cursor.slice(0, separator))),
    id: cursor.slice(separator + 1),
  }
}

export const formatCursor = (row: Keyset): string =>
  `${DateTime.toEpochMillis(row.createdAt)}:${row.id}`

/** `{ items, nextCursor }` from one core page; `null` once the list is spent. */
export const page = <A extends Keyset, W>(
  result: { readonly items: ReadonlyArray<A>; readonly hasMore: boolean },
  toWire: (row: A) => W,
): { readonly items: ReadonlyArray<W>; readonly nextCursor: string | null } => {
  const last = result.items[result.items.length - 1]
  return {
    items: result.items.map(toWire),
    nextCursor:
      result.hasMore && last !== undefined ? formatCursor(last) : null,
  }
}
