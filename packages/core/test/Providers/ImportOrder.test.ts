import { describe, expect, it } from "@effect/vitest"
import { execFileSync } from "node:child_process"
import { resolve } from "node:path"

/**
 * `alchemy deploy` evaluates a Worker or Workflow's init graph with Node's own
 * loader, so every provider module has to survive that loader whichever one of
 * them is reached first. Vite's module runner tolerates the ScrapeProviders and
 * Playwright cycle Node rejects, so the only way to see the real behaviour is
 * to drive the real loader in a child process (#35).
 */
const core = resolve(import.meta.dirname, "../..")

const load = (module: string) =>
  execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `await import("./src/${module}")`],
    { cwd: core, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )

describe("Providers under Node's loader", () => {
  for (const module of [
    "Providers/Playwright.ts",
    "Providers/Scrappey.ts",
    "Providers/ScrapeProviders.ts",
    "Layers.ts",
    "index.ts",
  ])
    it(`evaluates with ${module} first`, { timeout: 30_000 }, () => {
      expect(() => load(module)).not.toThrow()
    })
})
