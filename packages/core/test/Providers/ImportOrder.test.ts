import { describe, expect, it } from "@effect/vitest"
import { nodeLoaderArgs } from "alchemy/Util/Node"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

/**
 * Exercise Node's ESM evaluation with the same Oxc resolution hook installed
 * by the published Alchemy CLI. It resolves extensionless TypeScript imports;
 * Vite's module runner alone would miss the provider cycle regression (#35).
 */
const core = resolve(import.meta.dirname, "../..")

const load = (module: string) =>
  execFileSync(
    process.execPath,
    [
      ...nodeLoaderArgs(import.meta.resolve("alchemy")),
      "--input-type=module",
      "-e",
      `await import("./src/${module}")`,
    ],
    { cwd: core, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )

describe("Providers under Alchemy's Node loader", () => {
  for (const module of [
    "scrapes/providers/playwright",
    "scrapes/providers/scrappey",
    "scrapes/providers",
    "scrapes/runner",
    "products",
  ])
    it(`evaluates with ${module} first`, { timeout: 30_000 }, () => {
      expect(() => load(module)).not.toThrow()
    })
})
