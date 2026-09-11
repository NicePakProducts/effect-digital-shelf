import { betterAuth, type BetterAuthPlugin } from "better-auth"
import { magicLink } from "better-auth/plugins/magic-link"
import { jwt } from "better-auth/plugins/jwt"
import { mcp } from "@better-auth/mcp"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type * as Headers from "effect/unstable/http/Headers"
import { Db } from "../Sql/Db.ts"
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Better Auth requires this synchronous DBAdapter factory; it is not an Effect service constructor.
import { makeAdapter } from "./BetterAuthAdapter.ts"
import { EmailSender } from "./EmailSender.ts"
import { isAllowlisted, parseDomains } from "./Allowlist.ts"

export interface AuthenticatedUser {
  readonly id: string
  readonly email: string
}

export class SessionLookupFailed extends Data.TaggedError(
  "SessionLookupFailed",
)<{
  readonly cause: unknown
}> {}

const make = Effect.gen(function* () {
  const secret = yield* Config.redacted("AUTH_SECRET")
  const baseURL = yield* Config.string("AUTH_BASE_URL")

  const domains = parseDomains(
    yield* Config.string("AUTH_ALLOWED_EMAIL_DOMAINS").pipe(
      Config.withDefault("npbrands.com.au"),
    ),
  )

  const db = yield* Db
  const context = yield* Effect.context<Db>()
  const emails = yield* EmailSender
  const emailContext = yield* Effect.context<EmailSender>()

  const mcpPlugin = mcp({
    loginPage: "/sign-in",
    consentPage: "/consent",
    resource: `${baseURL}/mcp`,
  })

  const auth = betterAuth({
    appName: "Digital Shelf",
    baseURL,
    basePath: "/api/auth",
    secret: Redacted.value(secret),
    trustedOrigins: [baseURL],
    database: makeAdapter(db, context),
    session: { expiresIn: 30 * 24 * 60 * 60, updateAge: 24 * 60 * 60 },
    databaseHooks: {
      user: {
        create: {
          before: async (user) =>
            isAllowlisted(user.email, domains) ? undefined : false,
        },
      },
    },
    plugins: [
      // The first sign-in creates the User (issue #16).
      magicLink({
        expiresIn: 900,
        sendMagicLink: async ({ email, url }) => {
          if (isAllowlisted(email, domains))
            await Effect.runPromiseWith(emailContext)(
              emails.send({
                to: email,
                subject: "Sign in to Digital Shelf",
                text: `Sign in to Digital Shelf:\n\n${url}\n`,
              }),
            )
        },
      }),
      jwt(),
      {
        ...mcpPlugin,
        // SAFETY: Only unused OpenAPI metadata differs between plugin versions; endpoint names, handlers and signatures retain their original types.
        endpoints: mcpPlugin.endpoints as {
          [
            Key in keyof typeof mcpPlugin.endpoints
          ]: (typeof mcpPlugin.endpoints)[Key] & {
            options: {
              metadata: NonNullable<
                BetterAuthPlugin["endpoints"]
              >[string]["options"]["metadata"]
            }
          }
        },
      },
    ],
  })

  // getSession slides expiresAt but discards Set-Cookie; the browser cookie refreshes via /api/auth/get-session (issue #14's /me).
  const getSession = Effect.fn("Auth.getSession")(function* (
    headers: Headers.Headers | globalThis.Headers,
  ) {
    const session = yield* Effect.tryPromise({
      try: () =>
        auth.api.getSession({ headers: new globalThis.Headers(headers) }),
      catch: (cause) => new SessionLookupFailed({ cause }),
    })

    return session === null
      ? Option.none<AuthenticatedUser>()
      : Option.some<AuthenticatedUser>({
          id: session.user.id,
          email: session.user.email,
        })
  })

  const handle = Effect.fn("Auth.handle")(function* (
    request: globalThis.Request,
  ) {
    yield* Effect.annotateCurrentSpan({
      "http.request.method": request.method,
      "url.path": new URL(request.url).pathname,
    })

    return yield* Effect.promise(() => auth.handler(request))
  })

  return { getSession, handle, api: auth.api }
})

export type BetterAuthApi = Effect.Success<typeof make>["api"]

export class Auth extends Context.Service<Auth, Effect.Success<typeof make>>()(
  "@digital-shelf/core/Auth/Auth",
  { make },
) {
  static readonly layer = Layer.effect(this, this.make)
}
