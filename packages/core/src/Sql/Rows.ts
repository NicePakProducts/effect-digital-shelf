import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

/**
 * Rows cross the repository seam through the derived entity schemas (ADR
 * 0002): decoding turns Drizzle's `Date` and `null` into `DateTime.Utc` and
 * `Option`, encoding does the reverse for inserts and updates. A row that
 * fails to decode is a defect, not an error: the table and the entity come
 * from one definition, so a mismatch can only be a bug.
 */
export const decode = <S extends Schema.Constraint>(schema: S) => {
  const decodeRow = Schema.decodeEffect(schema)
  return (
    row: S["Encoded"],
  ): Effect.Effect<S["Type"], never, S["DecodingServices"]> =>
    Effect.orDie(decodeRow(row))
}

export const decodeAll = <S extends Schema.Constraint>(schema: S) => {
  const decodeRow = decode(schema)
  return (
    rows: ReadonlyArray<S["Encoded"]>,
  ): Effect.Effect<ReadonlyArray<S["Type"]>, never, S["DecodingServices"]> =>
    Effect.forEach(rows, decodeRow)
}

/** The one row a lookup by key returns, or none. */
export const decodeOptional = <S extends Schema.Constraint>(schema: S) => {
  const decodeRow = decode(schema)
  return (
    rows: ReadonlyArray<S["Encoded"]>,
  ): Effect.Effect<Option.Option<S["Type"]>, never, S["DecodingServices"]> => {
    const row = rows[0]
    return row === undefined
      ? Effect.succeedNone
      : Effect.asSome(decodeRow(row))
  }
}

/** The one row a write with `returning()` must produce. */
export const decodeOne = <S extends Schema.Constraint>(schema: S) => {
  const decodeRow = decode(schema)
  return (
    rows: ReadonlyArray<S["Encoded"]>,
  ): Effect.Effect<S["Type"], never, S["DecodingServices"]> => {
    const row = rows[0]
    return row === undefined
      ? Effect.die(new Error("expected the write to return one row"))
      : decodeRow(row)
  }
}

/** Encode a command-shaped value to the row Drizzle writes. */
export const encode = <S extends Schema.ConstraintEncoder<unknown, never>>(
  schema: S,
): ((input: S["Type"]) => S["Encoded"]) => Schema.encodeSync(schema)
