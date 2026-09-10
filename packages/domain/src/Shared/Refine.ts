import * as Schema from "effect/Schema"
import * as SchemaGetter from "effect/SchemaGetter"

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

/**
 * Tracker parameters, the glossary's fixed and deliberately narrow list: a
 * query parameter that identifies a campaign, click or visitor rather than
 * the page. Keys are matched exactly as listed, since query keys are case
 * sensitive, plus the `utm_` prefix. A parameter that may select content is
 * never here: a bare `ref` stays, Amazon's `th` stays, and a tracker carried
 * in the path (Amazon's `/ref=...`) is left alone.
 */
export const TrackerParameters: ReadonlySet<string> = new Set([
  "gclid",
  "dclid",
  "wbraid",
  "gbraid",
  "yclid",
  "fbclid",
  "igshid",
  "ttclid",
  "twclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "_hsenc",
  "_hsmi",
  "_ga",
  "vero_id",
  "ref_",
])

/** Whether a query parameter key names a Tracker parameter. */
export const isTrackerParameter = (key: string): boolean =>
  key.startsWith("utm_") || TrackerParameters.has(key)

/**
 * `scheme:` · `//` · authority · everything after it. The authority stops at
 * the first `/`, `?` or `#`; the remainder (path, query, fragment) is carried
 * through untouched so nothing is re-encoded.
 */
const parts = /^([A-Za-z][A-Za-z0-9+.-]*:)(\/\/)?([^/?#]*)([\s\S]*)$/

/** Lower-case the host, leaving any userinfo and the port as pasted. */
const lowerCaseHost = (authority: string): string => {
  const at = authority.lastIndexOf("@")
  return at === -1
    ? authority.toLowerCase()
    : `${authority.slice(0, at + 1)}${authority.slice(at + 1).toLowerCase()}`
}

/**
 * Drop Tracker parameters from a query string on `&` boundaries, taking the
 * bytes before the first `=` as the key. Survivors keep their bytes exactly:
 * the query is never round-tripped through `URLSearchParams`, so duplicate
 * keys, key order and percent-encoding all survive untouched.
 */
const filterQuery = (query: string): string =>
  query
    .split("&")
    .filter((parameter) => {
      const equals = parameter.indexOf("=")
      return !isTrackerParameter(
        equals === -1 ? parameter : parameter.slice(0, equals),
      )
    })
    .join("&")

/**
 * The Normalised URL of an absolute http(s) URL: scheme and host lower-cased,
 * Tracker parameters removed, a `?` left empty removed. Path, fragment, port
 * and every other parameter stay byte-for-byte as pasted, which is what makes
 * the function idempotent. Only `Url` calls it, on a value WHATWG parsing has
 * already accepted.
 */
export const normaliseUrl = (value: string): string => {
  const match = parts.exec(value)
  if (match === null) return value
  const [, scheme = "", slashes = "", authority = "", rest = ""] = match
  const hash = rest.indexOf("#")
  const beforeHash = hash === -1 ? rest : rest.slice(0, hash)
  const fragment = hash === -1 ? "" : rest.slice(hash)
  const origin = `${scheme.toLowerCase()}${slashes}${lowerCaseHost(authority)}`
  const mark = beforeHash.indexOf("?")
  if (mark === -1) return `${origin}${beforeHash}${fragment}`
  const query = filterQuery(beforeHash.slice(mark + 1))
  return `${origin}${beforeHash.slice(0, mark)}${
    query === "" ? "" : `?${query}`
  }${fragment}`
}

/** An absolute http(s) URL. Correctness beyond syntax is the user's. */
const Absolute = Schema.NonEmptyString.check(
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

/**
 * A Normalised URL: an absolute http(s) URL as `normaliseUrl` leaves it.
 * Decoding trims, parses, then normalises, so every command and every decoded
 * row carries the stored form and no code path can write an unnormalised one;
 * a value the parser rejects stays a schema failure. Encoding hands the
 * normalised string back unchanged, because it is the only URL kept.
 */
export const Url = Schema.NonEmptyString.annotate({ identifier: "Url" }).pipe(
  Schema.decodeTo(Absolute, {
    decode: SchemaGetter.trim(),
    encode: SchemaGetter.passthrough(),
  }),
  Schema.decodeTo(Absolute, {
    decode: SchemaGetter.transform(normaliseUrl),
    encode: SchemaGetter.passthrough(),
  }),
)
export type Url = typeof Url.Type
