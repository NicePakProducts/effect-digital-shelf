import * as Schema from "effect/Schema"

/**
 * The refine layer every derived entity applies on top of Drizzle's
 * `createSelectSchema` (ADR 0002). Drizzle hands rows over in its own JS shape
 * (`Date` for timestamptz, `boolean`, parsed JSON, `null` for NULL); these
 * helpers turn that into the domain's vocabulary.
 */

/** A `timestamptz` column surfaced as `DateTime.Utc`. */
export const Timestamp = Schema.DateTimeUtcFromDate

/** A nullable column: SQL NULL is `None`, never a sentinel value. */
export const nullable = <S extends Schema.Constraint>(schema: S) =>
  Schema.OptionFromNullOr(schema)

/**
 * A `jsonb` column whose shape the domain leaves open (cookies, IP info,
 * extracted JSON). A JSON `null` inside the value is data; only SQL NULL is
 * absence, which `nullable` handles.
 */
export const Json = Schema.Json

/** A non-empty, trimmed name as typed by the user. */
export const Name = Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString))

/** An absolute http(s) URL. Correctness beyond syntax is the user's. */
export const Url = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) => {
      if (!URL.canParse(value)) return "must be an absolute URL"
      const protocol = new URL(value).protocol
      return protocol === "http:" || protocol === "https:"
        ? undefined
        : "must use http or https"
    },
    { identifier: "Url" },
  ),
)
export type Url = typeof Url.Type
