import { describe, expect, it } from "@effect/vitest"
import { parseOrigin } from "@app/infra/Resources/Postgres"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

describe("Hyperdrive origin", () => {
  it.each(["postgres", "postgresql"])(
    "parses %s credentials and drops client query options",
    (scheme) => {
      const origin = Effect.runSync(
        parseOrigin(
          `${scheme}://postgres.branch:p%40ss%3Aword@db.example.com:5432/postgres?sslmode=verify-full`,
        ),
      )

      expect(origin).toEqual({
        scheme,
        host: "db.example.com",
        port: 5432,
        database: "postgres",
        user: "postgres.branch",
        password: Redacted.make("p@ss:word"),
      })
      expect(Redacted.value(origin.password)).toBe("p@ss:word")
      expect(JSON.stringify(origin)).not.toContain("p@ss:word")
      expect(origin).not.toHaveProperty("sslmode")
    },
  )

  it("defaults the port and decodes user and database names", () => {
    const origin = Effect.runSync(
      parseOrigin("postgres://test%2Euser:pw@localhost/shelf%2Dtest"),
    )

    expect(origin).toMatchObject({
      port: 5432,
      user: "test.user",
      database: "shelf-test",
    })
  })

  it("preserves an explicit port and handles IPv6", () => {
    expect(
      Effect.runSync(parseOrigin("postgres://user:pw@[::1]:5440/postgres")),
    ).toMatchObject({ host: "::1", port: 5440 })
  })

  it.each([
    "not a url",
    "https://user:pw@host/db",
    "mysql://user:pw@host/db",
    "postgres://user:pw@/db",
    "postgres://host/db",
    "postgres://user@host/db",
    "postgres://user:pw@host",
    "postgres://user:pw@host:0/db",
    "postgres://user:pw@host:70000/db",
    "postgres://user:pw@host/db#fragment",
    "postgres://user:%zz@host/db",
  ])("rejects invalid origins without leaking credentials (%s)", (url) => {
    const error = Effect.runSync(parseOrigin(url).pipe(Effect.flip))
    expect(error._tag).toBe("ConfigError")
    expect(error.message).toMatch(/DATABASE_URL/)
  })

  it("sanitizes parser failures instead of retaining the secret URL", () => {
    const error = Effect.runSync(
      parseOrigin("postgres://user:secret-password@host:bad/db").pipe(
        Effect.flip,
      ),
    )

    expect(String(error)).not.toContain("secret-password")
    expect(JSON.stringify(error)).not.toContain("secret-password")
    expect(error.cause).not.toHaveProperty("cause")
  })
})
