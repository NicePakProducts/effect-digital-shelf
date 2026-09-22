import { AuthErrors } from "./auth/errors"
import { betterAuth, type BetterAuthPlugin } from "better-auth"
import { magicLink } from "better-auth/plugins/magic-link"
import { jwt } from "better-auth/plugins/jwt"
import { mcp } from "@better-auth/mcp"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import type * as Headers from "effect/unstable/http/Headers"
import { Db } from "@app/db"
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Better Auth requires this synchronous DBAdapter factory; it is not an Effect service constructor.
import { makeAdapter, withInvocation } from "./auth/adapter"
import { EmailSender } from "./auth/email-sender"
import { isAllowlisted, parseDomains } from "./auth/allowlist"

export interface AuthenticatedUser {
  readonly id: string
  readonly email: string
}

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
  const emails = yield* EmailSender.Service
  const emailContext = yield* Effect.context<EmailSender.Service>()

  const mcpPlugin = mcp({
    loginPage: "/sign-in",
    consentPage: "/consent",
    resource: `${baseURL}/mcp`,
  })

  // Better Auth queries the database as soon as it is instantiated (its OAuth
  // provider seeds the MCP resource), so the instance is created on first use
  // and an invocation that never authenticates never reaches the database.
  const instance = yield* Effect.cached(
    Effect.sync(() =>
      betterAuth({
        appName: "Digital Shelf",
        baseURL,
        basePath: "/api/auth",
        secret: Redacted.value(secret),
        trustedOrigins: [baseURL],
        // Better Auth otherwise disables these checks under NODE_ENV=test.
        advanced: { disableOriginCheck: false, disableCSRFCheck: false },
        database: makeAdapter(db, context),
        session: {
          expiresIn: 30 * 24 * 60 * 60,
          updateAge: 24 * 60 * 60,
          // A signed cookie answers session checks without a database round
          // trip for five minutes; a revoked session can outlive its row by that long.
          cookieCache: { enabled: true, maxAge: 5 * 60 },
        },
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
      }),
    ),
  )

  // getSession slides expiresAt but discards Set-Cookie; the browser cookie refreshes via /api/auth/get-session (issue #14's /me).
  const getSession = Effect.fn("Auth.getSession")(function* (
    headers: Headers.Headers | globalThis.Headers,
  ) {
    const auth = yield* instance
    const services = yield* Effect.context<never>()

    const session = yield* Effect.tryPromise({
      try: () =>
        withInvocation(services, () =>
          auth.api.getSession({ headers: new globalThis.Headers(headers) }),
        ),
      catch: (cause) => new AuthErrors.SessionLookupFailed({ cause }),
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

    const auth = yield* instance
    const services = yield* Effect.context<never>()

    return yield* Effect.promise(() =>
      withInvocation(services, () => auth.handler(request)),
    )
  })

  return { getSession, handle }
})

export * as Auth from "./auth"

export { AuthErrors } from "./auth/errors"

export interface Interface {
  readonly getSession: (
    headers: Headers.Headers | globalThis.Headers,
  ) => Effect.Effect<
    Option.Option<AuthenticatedUser>,
    AuthErrors.SessionLookupFailed
  >
  readonly handle: (
    request: globalThis.Request,
  ) => Effect.Effect<globalThis.Response>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/auth",
) {}

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(Layer.provide(EmailSender.layer))
