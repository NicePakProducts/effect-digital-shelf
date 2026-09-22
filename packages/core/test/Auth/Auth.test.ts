import * as Result from "effect/Result"
import * as Context from "effect/Context"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as PgDrizzle from "drizzle-orm/effect-pglite"
import { EffectLogger } from "drizzle-orm/effect-core"
import { expect, it } from "@effect/vitest"
import { Auth } from "@app/core/auth"
import { makeAdapter } from "../../src/auth/adapter"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import * as Sql from "@app/db/schema"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"
import { EmailSenderTest } from "../layers/EmailSender"

const prepare = Effect.gen(function* () {
  yield* DbTest.resetAuth
  const emails = yield* EmailSenderTest
  yield* emails.clear

  const auth = yield* Auth.Service

  return { auth, emails, db: yield* Db }
})

const requestLink = (auth: Auth.Interface, email = "someone@npbrands.com.au") =>
  auth.handle(
    new Request("http://localhost/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: JSON.stringify({ email, callbackURL: "/" }),
    }),
  )

const tokenFrom = (text: string) =>
  new URL(text.trim().split("\n").at(-1)!).searchParams.get("token")!

const verify = (auth: Auth.Interface, token: string) =>
  auth.handle(
    new Request(
      `http://localhost/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    ),
  )

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Auth", (it) => {
  it.effect("sends a magic link to an allowlisted address", () =>
    Effect.gen(function* () {
      const { auth, emails } = yield* prepare
      yield* requestLink(auth)
      const sent = yield* emails.sent
      expect(sent).toHaveLength(1)
      expect(sent[0]!.to).toBe("someone@npbrands.com.au")
      expect(sent[0]!.text).toContain("/api/auth/magic-link/verify?token=")
    }),
  )
  it.effect(
    "silently drops non-allowlisted addresses and creates no user",
    () =>
      Effect.gen(function* () {
        const { auth, emails, db } = yield* prepare
        yield* requestLink(auth, "someone@example.com")
        expect(yield* emails.sent).toEqual([])
        expect(yield* query(db.select().from(Sql.UsersTable))).toEqual([])
      }),
  )
  it.effect(
    "blocks user creation even when a disallowed address has a valid token",
    () =>
      Effect.gen(function* () {
        const { auth, db } = yield* prepare
        yield* requestLink(auth, "someone@example.com")
        const tokens = yield* query(db.select().from(Sql.VerificationsTable))
        expect(tokens).toHaveLength(1)

        const result = yield* verify(auth, tokens[0]!.identifier)
        expect(result.status).toBe(302)
        expect(result.headers.get("location")).toContain(
          "error=failed_to_create_user",
        )

        expect(yield* query(db.select().from(Sql.UsersTable))).toEqual([])
        expect(yield* query(db.select().from(Sql.SessionsTable))).toEqual([])
      }),
  )
  it.effect(
    "verifies once, creates a user and session, and reuses the user on a later sign-in",
    () =>
      Effect.gen(function* () {
        const { auth, emails, db } = yield* prepare
        yield* requestLink(auth)
        const token = tokenFrom((yield* emails.sent)[0]!.text)
        const verified = yield* verify(auth, token)

        const cookies = verified.headers
          .getSetCookie()
          .map((cookie) => cookie.split(";")[0])
          .join("; ")

        expect(cookies).toContain("better-auth.session_token=")
        const users = yield* query(db.select().from(Sql.UsersTable))
        expect(users).toHaveLength(1)
        expect(
          yield* auth.getSession(new Headers({ cookie: cookies })),
        ).toEqual(Option.some({ id: users[0]!.id, email: users[0]!.email }))
        expect(yield* auth.getSession(new Headers())).toEqual(Option.none())
        expect(
          yield* auth.getSession(
            new Headers({ cookie: "better-auth.session_token=garbage" }),
          ),
        ).toEqual(Option.none())

        const replay = yield* verify(auth, token)
        expect(replay.status).toBe(302)
        expect(replay.headers.get("location")).toContain("error=INVALID_TOKEN")

        yield* emails.clear
        yield* requestLink(auth)
        const nextToken = tokenFrom((yield* emails.sent)[0]!.text)
        yield* verify(auth, nextToken)
        expect(yield* query(db.select().from(Sql.UsersTable))).toHaveLength(1)
      }),
  )
  it.effect("rolls back a failing Better Auth transaction", () =>
    Effect.gen(function* () {
      const { db } = yield* prepare
      // PGlite has one connection: rollback alone cannot prove queries joined the transaction.
      const sqlClient = yield* SqlClient.SqlClient
      const queryContexts: Array<Context.Context<never>> = []

      const observedDb = yield* PgDrizzle.make().pipe(
        Effect.provideService(EffectLogger, {
          logQuery: () =>
            Effect.gen(function* () {
              queryContexts.push(yield* Effect.context<never>())
            }),
        }),
        Effect.provide(PgDrizzle.DefaultServices),
      )

      const context = yield* Effect.context<Db>()
      expect(
        Context.getOption(context, sqlClient.transactionService)._tag,
      ).toBe("None")
      const adapter = makeAdapter(observedDb, context)({})

      const result = yield* Effect.tryPromise(() =>
        adapter.transaction(async (tx) => {
          await tx.create({
            model: "user",
            data: {
              id: "rolled-back",
              name: "Rollback",
              email: "rollback@npbrands.com.au",
              emailVerified: false,
            },
          })
          expect(
            await tx.findOne({
              model: "user",
              where: [{ field: "email", value: "rollback@npbrands.com.au" }],
            }),
          ).toMatchObject({ name: "Rollback" })
          expect(queryContexts).toHaveLength(2)

          for (const inner of queryContexts)
            expect(
              Context.getOption(inner, sqlClient.transactionService)._tag,
            ).toBe("Some")
          throw new Error("boom")
        }),
      ).pipe(Effect.result)

      expect(result._tag).toBe("Failure")

      if (Result.isFailure(result))
        expect(result.failure.cause).toMatchObject({ message: "boom" })
      expect(queryContexts).toHaveLength(2)

      for (const inner of queryContexts)
        expect(
          Context.getOption(inner, sqlClient.transactionService)._tag,
        ).toBe("Some")
      expect(yield* query(db.select().from(Sql.UsersTable))).toEqual([])
    }),
  )
  it.effect(
    "the adapter preserves filtering, projections, write counts and SQL failures",
    () =>
      Effect.gen(function* () {
        const { db } = yield* prepare
        const adapter = makeAdapter(db, yield* Effect.context<Db>())({})
        yield* Effect.promise(async () => {
          for (const [name, email] of [
            ["Alpha", "alpha@npbrands.com.au"],
            ["Beta", "beta@npbrands.com.au"],
          ]) {
            await adapter.create({
              model: "user",
              data: { name, email, emailVerified: false },
            })
          }

          expect(
            await adapter.count({
              model: "user",
              where: [
                {
                  field: "email",
                  operator: "ends_with",
                  value: "@NPBRANDS.COM.AU",
                  mode: "insensitive",
                },
              ],
            }),
          ).toBe(2)
          expect(
            await adapter.findMany({
              model: "user",
              select: ["name"],
              sortBy: { field: "name", direction: "desc" },
              limit: 1,
              offset: 1,
            }),
          ).toEqual([{ name: "Alpha" }])
          expect(
            await adapter.updateMany({
              model: "user",
              where: [
                {
                  field: "name",
                  operator: "in",
                  value: ["ALPHA", "BETA"],
                  mode: "insensitive",
                },
              ],
              update: { emailVerified: true },
            }),
          ).toBe(2)
          expect(
            await adapter.findOne({
              model: "user",
              select: ["emailVerified"],
              where: [{ field: "name", value: "Alpha" }],
            }),
          ).toEqual({ emailVerified: true })
          await expect(
            adapter.create({
              model: "user",
              data: {
                name: "Duplicate",
                email: "alpha@npbrands.com.au",
                emailVerified: false,
              },
            }),
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
          ).rejects.toMatchObject({ _tag: "SqlError" })
          expect(
            await adapter.deleteMany({
              model: "user",
              where: [{ field: "name", operator: "ne", value: "Alpha" }],
            }),
          ).toBe(1)
          expect(
            await adapter.deleteMany({
              model: "user",
              where: [{ field: "name", value: "absent" }],
            }),
          ).toBe(0)
        })
      }),
  )
  it.effect("propagates email delivery failures", () =>
    Effect.gen(function* () {
      const { auth, emails } = yield* prepare
      yield* emails.fail

      const result = yield* requestLink(auth)
      expect(result.status).toBe(500)
      expect(yield* emails.sent).toEqual([])
    }),
  )
})
