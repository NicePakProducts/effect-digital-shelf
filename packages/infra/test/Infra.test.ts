import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { packageName } from "@digital-shelf/infra"

describe("@digital-shelf/infra", () => {
  it.effect("runs an Effect on the RC toolchain", () =>
    Effect.gen(function* () {
      const name = yield* Effect.succeed(packageName)
      expect(name).toBe("@digital-shelf/infra")
    }),
  )
})
