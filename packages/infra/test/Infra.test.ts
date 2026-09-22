import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { packageName } from "@app/infra"

describe("@app/infra", () => {
  it.effect("runs an Effect on the RC toolchain", () =>
    Effect.gen(function* () {
      const name = yield* Effect.succeed(packageName)
      expect(name).toBe("@app/infra")
    }),
  )
})
