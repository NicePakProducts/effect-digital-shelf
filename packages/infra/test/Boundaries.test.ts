import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { dirname, join, relative, resolve } from "node:path"

const src = resolve(import.meta.dirname, "../src")
const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((entry) => {
    const file = join(dir, entry)
    return statSync(file).isDirectory() ? walk(file) : [file]
  })

// Follow core's import walk, including re-exports, side effects and literal
// dynamic imports. Strip types with Node to distinguish runtime Alchemy edges
// from both `import type` and `import { type ... }` without a second TS parser.
const importsOf = (source: string) => [
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

const edges = walk(src)
  .filter((file) => /\.[cm]?ts$/.test(file))
  .flatMap((file) => {
    const source = readFileSync(file, "utf8")
    const runtime = new Set(importsOf(stripTypeScriptTypes(source)))
    return importsOf(source).map((specifier) => ({
      file: relative(src, file),
      typeOnly: !runtime.has(specifier),
      specifier: specifier.startsWith(".")
        ? relative(src, resolve(dirname(file), specifier))
        : specifier,
    }))
  })

describe("infra import boundary (ADR 0006)", () => {
  it("never reaches API or an app, even through a type or dynamic import", () => {
    expect(
      edges.filter(
        ({ specifier }) =>
          /^@digital-shelf\/(?:api|server)(?:\/|$)/.test(specifier) ||
          /(?:^|\/)apps(?:\/|$)/.test(specifier) ||
          /(?:^|\/)packages\/api(?:\/|$)/.test(specifier),
      ),
    ).toEqual([])
  })

  it("adapters import Alchemy only as types", () => {
    expect(
      edges.filter(
        ({ file, specifier, typeOnly }) =>
          file.startsWith("Adapters/") &&
          /^alchemy(?:\/|$)/.test(specifier) &&
          !typeOnly,
      ),
    ).toEqual([])
  })
})
