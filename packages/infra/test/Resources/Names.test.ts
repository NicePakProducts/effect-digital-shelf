import { describe, expect, it } from "@effect/vitest"
import { resourceName, stageOf } from "@digital-shelf/infra/Resources/Names"

describe("resource names", () => {
  it.each(["dev", "prod"])("accepts %s", (stage) => {
    expect(stageOf(stage)).toBe(stage)
    expect(resourceName(stageOf(stage), "bucket")).toBe(
      `digital-shelf-bucket-${stage}`,
    )
    expect(resourceName(stageOf(stage), "ai-gateway")).toBe(
      `digital-shelf-ai-gateway-${stage}`,
    )
  })

  it.each(["", "vdelapena", "dev_vdelapena", "production", "DEV", " dev"])(
    "rejects unsupported stage %s",
    (stage) => {
      expect(() => stageOf(stage)).toThrow(/use --stage dev or --stage prod/)
    },
  )
})
