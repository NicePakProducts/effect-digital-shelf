import { describe, expect, it } from "@effect/vitest"
import { Db } from "@app/db"
import * as Adapter from "@app/db/adapter"
import { sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Redacted from "effect/Redacted"

// Nothing listens on this port, so any connection attempt is refused at once.
const unreachable = Redacted.make("postgres://nobody:nothing@127.0.0.1:1/none")

describe("Db adapter", () => {
  it.layer(Adapter.layer(Effect.succeed(unreachable)))(
    "built once per isolate",
    (it) => {
      it.effect(
        "builds without a connection; an invocation's first statement opens it",
        () =>
          Effect.gen(function* () {
            const db = yield* Db

            const failed = yield* Effect.flip(
              Effect.scoped(db.execute(sql`SELECT 1`)),
            )

            expect(failed._tag).toBe("EffectDrizzleQueryError")
          }),
      )
    },
  )
})
