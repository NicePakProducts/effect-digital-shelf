import * as Schema from "effect/Schema"

/**
 * The normalised result of a Scrape shared by both modes. Gaps one mode cannot
 * fill are `None`, never placeholders. HTML travels beside the envelope, never
 * inside it; `raw` is the provider's full response with HTML stripped, kept
 * for forensics only and stored in R2 by core.
 */
export const Headers = Schema.Record(Schema.String, Schema.String)
export type Headers = typeof Headers.Type

export const ScrapeEnvelope = Schema.Struct({
  finalUrl: Schema.String,
  statusCode: Schema.Int,
  responseHeaders: Headers,
  cookies: Schema.Json,
  innerText: Schema.String,
  userAgent: Schema.String,
  ipInfo: Schema.Option(Schema.Json),
  type: Schema.String,
  session: Schema.Option(Schema.String),
  raw: Schema.Json,
  /** Fetch attempts the provider made for this one Scrape. */
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type ScrapeEnvelope = typeof ScrapeEnvelope.Type
