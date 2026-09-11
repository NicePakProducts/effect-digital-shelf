import * as Hyperdrive from "alchemy/Cloudflare/Hyperdrive"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"
import type { Stage } from "./Names.ts"

/** Parse only origin fields; URL query options belong to the direct client. */
export const parseOrigin = (value: string): Hyperdrive.PublicOrigin => {
  // URL/percent-decoding errors can include the connection string. Do not
  // retain them as causes: DATABASE_URL contains the database password.
  let url: URL
  let user: string
  let password: string
  let database: string

  try {
    url = new URL(value)
    user = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
    database = decodeURIComponent(url.pathname.slice(1))
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL URL")
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("DATABASE_URL must use postgres:// or postgresql://")

  if (!url.hostname || !user || !password || !database || url.hash)
    throw new Error(
      "DATABASE_URL requires a host, user, password and database, with no fragment",
    )
  const port = url.port === "" ? 5432 : Number(url.port)

  if (port < 1) throw new Error("DATABASE_URL port must be between 1 and 65535")

  return {
    scheme: url.protocol === "postgres:" ? "postgres" : "postgresql",
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    database,
    user,
    password: Redacted.make(password),
  }
}

export const make = ({
  stage,
  databaseUrl,
}: {
  readonly stage: Stage
  readonly databaseUrl: Redacted.Redacted<string>
}) =>
  Effect.gen(function* () {
    const origin = parseOrigin(Redacted.value(databaseUrl))

    return yield* Hyperdrive.Connection("Postgres", {
      name: stage === "prod" ? "digital-shelf" : "digital-shelf-dev",
      origin,
      caching: { disabled: true },
      dev: { ...origin, sslmode: "verify-full" },
    }).pipe(RemovalPolicy.retain())
  })
