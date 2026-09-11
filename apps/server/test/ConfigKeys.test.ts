import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  bind,
  configKeys,
  requiredKeys,
  secretKeys,
} from "../src/ConfigKeys.ts"

const core = resolve(import.meta.dirname, "../../../packages/core/src")

const sources = readdirSync(core, {
  recursive: true,
  encoding: "utf8",
}).flatMap((file) =>
  file.endsWith(".ts") ? [readFileSync(resolve(core, file), "utf8")] : [],
)

describe("config binding coverage", () => {
  it("includes every literal core Config key, including multiline calls", () => {
    const keys = sources.flatMap((source) =>
      Array.from(
        source.matchAll(/Config\.[a-zA-Z]+\(\s*["']([A-Z_]+)["']/g),
        (match) => match[1]!,
      ),
    )

    expect(keys.length).toBeGreaterThan(20)
    expect(keys).toContain("EXTRACTION_MAX_OUTPUT_TOKENS")
    expect(
      keys.filter((key) => !configKeys.some((bound) => bound === key)),
    ).toEqual([])
    expect(new Set(configKeys).size).toBe(configKeys.length)
  })

  it("includes the provider retry keys composed from prefixes", () => {
    const source = readFileSync(
      resolve(core, "Providers/ScrapeProviders.ts"),
      "utf8",
    )

    const prefixes = Array.from(
      source.matchAll(/policy\("([A-Z_]+)"\)/g),
      (match) => match[1]!,
    )

    const suffixes = Array.from(
      source.matchAll(/Config\.[a-zA-Z]+\(`\$\{prefix\}([A-Z_]+)`\)/g),
      (match) => match[1]!,
    )

    expect(prefixes).toEqual(["BROWSER", "SCRAPPEY"])
    expect(suffixes).toHaveLength(3)

    for (const prefix of prefixes)
      for (const suffix of suffixes)
        expect(configKeys).toContain(`${prefix}${suffix}`)
  })

  it.effect("reads every key once and allows missing optional values", () => {
    const reads: string[] = []
    const required = new Set<string>([...requiredKeys, ...secretKeys])

    const provider = ConfigProvider.make((path) => {
      const key = path.join("_")
      reads.push(key)

      return Effect.succeed(
        required.has(key) ? ConfigProvider.makeValue("test-value") : undefined,
      )
    })

    return bind.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, provider),
      Effect.tap(() => Effect.sync(() => expect(reads).toEqual(configKeys))),
    )
  })
})
