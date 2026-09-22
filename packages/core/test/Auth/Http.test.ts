import { expect, it } from "@effect/vitest"
import { Auth } from "@app/core/auth"
import * as Effect from "effect/Effect"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import * as Sql from "@app/db/schema"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"
import { EmailSenderTest } from "../layers/EmailSender"

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })(
  "Browser auth HTTP",
  (it) => {
    it.effect("registers the JWT and MCP OAuth HTTP metadata endpoints", () =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service

        const jwks = yield* auth.handle(
          new Request("http://localhost/api/auth/jwks"),
        )

        expect(jwks.status).toBe(200)
        expect(yield* Effect.promise(() => jwks.json())).toHaveProperty("keys")

        const oauth = yield* auth.handle(
          new Request(
            "http://localhost/api/auth/.well-known/oauth-authorization-server",
          ),
        )

        expect(oauth.status).toBe(200)
        expect(yield* Effect.promise(() => oauth.json())).toMatchObject({
          authorization_endpoint: "http://localhost/api/auth/oauth2/authorize",
          token_endpoint: "http://localhost/api/auth/oauth2/token",
        })
      }),
    )
    it.effect(
      "keeps origin and callback checks enabled in the test environment",
      () =>
        Effect.gen(function* () {
          const auth = yield* Auth.Service

          for (const input of [
            { origin: "https://evil.test", callbackURL: "/" },
            { origin: "http://localhost", callbackURL: "https://evil.test" },
          ]) {
            const response = yield* auth.handle(
              new Request("http://localhost/api/auth/sign-in/magic-link", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  origin: input.origin,
                },
                body: JSON.stringify({
                  email: "browser@npbrands.com.au",
                  callbackURL: input.callbackURL,
                }),
              }),
            )

            expect(response.status).toBe(403)
          }
        }),
    )
    it.effect(
      "expired links use the same recovery as missing links; disallowed email is suppressed",
      () =>
        Effect.gen(function* () {
          yield* DbTest.resetAuth
          const auth = yield* Auth.Service
          const emails = yield* EmailSenderTest
          const db = yield* Db
          yield* emails.clear

          const request = (email: string) =>
            auth.handle(
              new Request("http://localhost/api/auth/sign-in/magic-link", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  origin: "http://localhost",
                },
                body: JSON.stringify({
                  email,
                  callbackURL: "/",
                  errorCallbackURL: "/sign-in",
                }),
              }),
            )

          expect((yield* request("suppressed@example.com")).status).toBe(200)
          expect(yield* emails.sent).toEqual([])
          expect((yield* request("expired@npbrands.com.au")).status).toBe(200)
          const url = (yield* emails.sent)[0]!.text.trim().split("\n").at(-1)!
          // Fixture setup only: Better Auth reads wall time outside Effect's TestClock.
          yield* query(
            db
              .update(Sql.VerificationsTable)
              .set({ expiresAt: new Date("2000-01-01T00:00:00Z") }),
          )
          const expired = yield* auth.handle(new Request(url))
          expect(
            new URL(expired.headers.get("location")!).searchParams.get("error"),
          ).toBe("INVALID_TOKEN")
          expect(expired.headers.getSetCookie().join(";")).not.toContain(
            "better-auth.session_token=",
          )
        }),
    )
    it.effect(
      "round-trips encoded callbacks, issues cookies, rejects reuse, restores and signs out",
      () =>
        Effect.gen(function* () {
          yield* DbTest.resetAuth
          const auth = yield* Auth.Service
          const emails = yield* EmailSenderTest
          yield* emails.clear
          const path = "/?q=Nice%20Pak%26Co#list"

          const requested = yield* auth.handle(
            new Request("http://localhost/api/auth/sign-in/magic-link", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "http://localhost",
              },
              body: JSON.stringify({
                email: "browser@npbrands.com.au",
                callbackURL: "/?q=Nice%2520Pak%2526Co#list",
                newUserCallbackURL: "/?q=Nice%2520Pak%2526Co#list",
                errorCallbackURL:
                  "/sign-in?redirect=%252F%253Fq%253DNice%252520Pak%252526Co%2523list",
              }),
            }),
          )

          expect(requested.status).toBe(200)
          const sent = yield* emails.sent
          const url = sent[0]!.text.trim().split("\n").at(-1)!
          const verified = yield* auth.handle(new Request(url))
          expect(verified.headers.get("location")).toBe(
            "http://localhost/?q=Nice%20Pak%26Co#list",
          )

          const cookies = verified.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0])
            .join("; ")

          expect(cookies).toContain("better-auth.session_token=")
          const replay = yield* auth.handle(new Request(url))
          const recovery = new URL(replay.headers.get("location")!)
          expect(recovery.searchParams.get("error")).toBe("INVALID_TOKEN")
          expect(recovery.searchParams.get("redirect")).toBe(path)

          const restored = yield* auth.handle(
            new Request("http://localhost/api/auth/get-session", {
              headers: { cookie: cookies },
            }),
          )

          expect(yield* Effect.promise(() => restored.json())).toMatchObject({
            user: { email: "browser@npbrands.com.au" },
          })

          const signedOut = yield* auth.handle(
            new Request("http://localhost/api/auth/sign-out", {
              method: "POST",
              headers: { cookie: cookies, origin: "http://localhost" },
            }),
          )

          expect(signedOut.status).toBe(200)
          expect(signedOut.headers.getSetCookie().join(";")).toContain(
            "Max-Age=0",
          )

          const after = yield* auth.handle(
            new Request("http://localhost/api/auth/get-session"),
          )

          expect(yield* Effect.promise(() => after.json())).toBeNull()
        }),
    )
  },
)
