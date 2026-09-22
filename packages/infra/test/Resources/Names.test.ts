import { describe, expect, it } from "@effect/vitest"
import {
  isDeployedStage,
  resourceName,
  stageOf,
} from "@app/infra/Resources/Names"

describe("resource names", () => {
  it.each(["dev", "prod"])("accepts deployed stage %s", (stage) => {
    expect(isDeployedStage(stage)).toBe(true)
    expect(stageOf(stage)).toBe(stage)
    expect(resourceName(stageOf(stage), "bucket")).toBe(
      `digital-shelf-bucket-${stage}`,
    )
    expect(resourceName(stageOf(stage), "ai-gateway")).toBe(
      `digital-shelf-ai-gateway-${stage}`,
    )
  })

  it.each(["", "vdelapena", "dev_vdelapena", "production", "DEV", " dev"])(
    "does not treat %s as a deployed stage",
    (stage) => {
      expect(isDeployedStage(stage)).toBe(false)
    },
  )

  it.each(["dev_vdelapena", "dev_ruie", "local"])(
    "runs private stage %s with dev settings",
    (stage) => {
      expect(stageOf(stage)).toBe("dev")
    },
  )
})
