import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const src = resolve(import.meta.dirname, "../src")
const edges = readdirSync(src, { recursive: true })
  .filter((file) => typeof file === "string" && file.endsWith(".ts"))
  .flatMap((entry) => {
    const file = resolve(src, String(entry))
    const source = readFileSync(file, "utf8")
    const imports = [
      ...Array.from(
        source.matchAll(
          /^(?:(?:import|export)\b[^;]*?\bfrom\s+|import\s+)["']([^"']+)["']/gm,
        ),
        (match) => match[1]!,
      ),
      ...Array.from(
        source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
        (match) => match[1]!,
      ),
    ]
    return imports.map((specifier) => ({
      file: relative(src, file),
      specifier: specifier.startsWith(".")
        ? relative(src, resolve(dirname(file), specifier))
        : specifier,
    }))
  })

describe("server composition boundary (ADR 0006)", () => {
  it("imports only API contracts or the two public execution entrypoints", () => {
    expect(
      edges.filter(({ specifier }) => {
        const match =
          /(?:^@digital-shelf\/api(?:\/|$)|packages\/api\/src\/)(.*)/.exec(
            specifier,
          )
        if (!match) return false
        const module = match[1]!.replace(/\.ts$/, "")
        return !(
          /(?:^|\/)[^/]+(?:Api|Wire)$/.test(module) ||
          /^(?:Api|RootApi|Auth\/AuthRoutes|Auth\/Security|(?:Catalog|Scraping)\/Errors)$/.test(
            module,
          )
        )
      }),
    ).toEqual([])
  })

  it("never imports test helpers", () => {
    expect(
      edges.filter(({ specifier }) => /(?:^|\/)test(?:\/|$)/.test(specifier)),
    ).toEqual([])
  })
})
