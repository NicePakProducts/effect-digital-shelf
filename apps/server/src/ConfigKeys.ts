import * as Config from "effect/Config"
import * as Effect from "effect/Effect"

/** Read once in Worker init; defaults remain owned by core. */
export const requiredKeys = [
  "AI_GATEWAY_ACCOUNT_ID",
  "AI_GATEWAY_ID",
  "AUTH_BASE_URL",
  "POSTMARK_FROM",
] as const
export const secretKeys = [
  "AI_GATEWAY_TOKEN",
  "AUTH_SECRET",
  "POSTMARK_SERVER_TOKEN",
  "SCRAPPEY_API_KEY",
] as const
export const optionalKeys = [
  "AUTH_ALLOWED_EMAIL_DOMAINS",
  "POSTMARK_MESSAGE_STREAM",
  "SCRAPPEY_ENDPOINT",
  "EXTRACTION_MODEL",
  "CRON_START_CAP",
  "EXTRACTION_DRAIN_CAP",
  "STUCK_BOUND",
  "FAILURE_RETRY_INTERVAL",
  "RETENTION_WINDOW",
  "RETENTION_CAP",
  "SCRAPE_DEADLINE",
  "INNER_TEXT_CAP_BYTES",
  "FETCH_ATTEMPT_DEADLINE",
  "BROWSER_MAX_ATTEMPTS",
  "BROWSER_RETRY_BASE_DELAY",
  "BROWSER_RETRY_MAX_DELAY",
  "SCRAPPEY_MAX_ATTEMPTS",
  "SCRAPPEY_RETRY_BASE_DELAY",
  "SCRAPPEY_RETRY_MAX_DELAY",
  "EXTRACTION_DEADLINE",
  "EXTRACTION_RETRIES",
  "EXTRACTION_INPUT_CAP_BYTES",
  "EXTRACTION_MAX_OUTPUT_TOKENS",
  "SERVER_HOSTNAME",
] as const
export const configKeys = [...requiredKeys, ...secretKeys, ...optionalKeys]

export const bind = Effect.gen(function* () {
  for (const key of requiredKeys) yield* Config.string(key)
  for (const key of secretKeys) yield* Config.redacted(key)
  for (const key of optionalKeys) yield* Config.option(Config.string(key))
})
