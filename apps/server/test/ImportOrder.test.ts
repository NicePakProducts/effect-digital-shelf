import { describe, expect, it } from "@effect/vitest"
import { nodeLoaderArgs } from "alchemy/Util/Node"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

describe("server init graph under Alchemy's Node loader", () => {
  for (const module of ["Worker", "ScrapeWorkflow", "ExtractionWorkflow"]) {
    it(`evaluates with ${module} first`, { timeout: 120_000 }, () => {
      expect(() =>
        execFileSync(
          process.execPath,
          [
            ...nodeLoaderArgs(import.meta.resolve("alchemy")),
            "--input-type=module",
            "-e",
            `await import("./src/${module}")`,
          ],
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
