import { describe, expect, it } from "@effect/vitest"
import { lifecycleRules } from "@digital-shelf/infra/Resources/Bucket"

describe("R2 orphan backstop", () => {
  it("expires only HTML and raw payloads at 97 days", () => {
    expect(lifecycleRules).toHaveLength(2)
    expect(new Set(lifecycleRules.map((rule) => rule.id)).size).toBe(2)
    expect(lifecycleRules.map(({ prefix }) => prefix)).toEqual([
      "html/",
      "raw/",
    ])
    for (const rule of lifecycleRules) {
      expect(rule.enabled).toBe(true)
      expect(rule.deleteObjectsTransition).toEqual({
        condition: { type: "Age", maxAge: 8_380_800 },
      })
      expect(rule).not.toHaveProperty("abortMultipartUploadsTransition")
      expect(rule).not.toHaveProperty("storageClassTransitions")
    }
  })
})
