import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

describe("server init graph under Node's loader", () => {
  for (const module of [
    "Worker.ts",
    "ScrapeWorkflow.ts",
    "ExtractionWorkflow.ts",
  ]) {
    it(`evaluates with ${module} first`, { timeout: 120_000 }, () => {
      expect(() =>
        execFileSync(
          process.execPath,
          ["--input-type=module", "-e", `await import("./src/${module}")`],
          {
            cwd: resolve(import.meta.dirname, ".."),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        ),
      ).not.toThrow()
    })
  }
})
