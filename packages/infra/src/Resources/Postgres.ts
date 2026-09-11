import * as Hyperdrive from "alchemy/Cloudflare/Hyperdrive"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { ConfigError } from "effect/Config"
import { SourceError } from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { Stage } from "./Names.ts"

/** A malformed DATABASE_URL is a configuration failure; the message never carries the URL. */
const invalid = (message: string) =>
  Effect.fail(new ConfigError(new SourceError({ message })))

export const make = ({
  stage,
  databaseUrl,
}: {
  readonly stage: Stage
  readonly databaseUrl: Redacted.Redacted<string>
}) =>
  Effect.gen(function* () {
    const origin = yield* parseOrigin(Redacted.value(databaseUrl))

    return yield* Hyperdrive.Connection("Postgres", {
      name: stage === "prod" ? "digital-shelf" : "digital-shelf-dev",
      origin,
      caching: { disabled: true },
      dev: { ...origin, sslmode: "verify-full" },
    }).pipe(RemovalPolicy.retain())
  })

/** Parse only origin fields; URL query options belong to the direct client. */
export const parseOrigin = (
  value: string,
): Effect.Effect<Hyperdrive.PublicOrigin, ConfigError> =>
  Effect.gen(function* () {
    // URL/percent-decoding errors can include the connection string. Do not
    // retain them as causes: DATABASE_URL contains the database password.
    const parsed = yield* Effect.try({
      try: () => {
        const url = new URL(value)

        return {
          url,
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
          database: decodeURIComponent(url.pathname.slice(1)),
        }
      },
      catch: () =>
        new ConfigError(
          new SourceError({
            message: "DATABASE_URL must be a valid PostgreSQL URL",
          }),
        ),
    })

    if (
      parsed.url.protocol !== "postgres:" &&
      parsed.url.protocol !== "postgresql:"
    )
      return yield* invalid(
        "DATABASE_URL must use postgres:// or postgresql://",
      )

    if (
      !parsed.url.hostname ||
      !parsed.user ||
      !parsed.password ||
      !parsed.database ||
      parsed.url.hash
    )
      return yield* invalid(
        "DATABASE_URL requires a host, user, password and database, with no fragment",
      )
    const port = parsed.url.port === "" ? 5432 : Number(parsed.url.port)

    if (port < 1)
      return yield* invalid("DATABASE_URL port must be between 1 and 65535")

    return {
      scheme: parsed.url.protocol === "postgres:" ? "postgres" : "postgresql",
      host: parsed.url.hostname.replace(/^\[|\]$/g, ""),
      port,
      database: parsed.database,
      user: parsed.user,
      password: Redacted.make(parsed.password),
    }
  })
