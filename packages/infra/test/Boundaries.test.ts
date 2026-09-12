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
// dynamic imports. Node strips `import type`; `import { type X }` becomes
// `import {}` and still counts as runtime under verbatimModuleSyntax.
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

const edgesOf = (file: string, source: string) => {
  const runtime = new Set(importsOf(stripTypeScriptTypes(source)))

  return importsOf(source).map((specifier) => ({
    file: relative(src, file),
    typeOnly: !runtime.has(specifier),
    specifier: specifier.startsWith(".")
      ? relative(src, resolve(dirname(file), specifier))
      : specifier,
  }))
}

// Alchemy's `Drizzle` and `SQL` modules are Effect helpers for the invocation's
// connection lifecycle, not Cloudflare resources; adapters may run them
// (ADR 0006, amended by ADR 0010).
const runtimeHelper = /^alchemy\/(?:Drizzle|SQL)(?:\/|$)/

const runtimeAlchemyEdges = (edges: ReturnType<typeof edgesOf>) =>
  edges.filter(
    ({ file, specifier, typeOnly }) =>
      file.startsWith("Adapters/") &&
      /^alchemy(?:\/|$)/.test(specifier) &&
      !runtimeHelper.test(specifier) &&
      !typeOnly,
  )

const edges = walk(src)
  .filter((file) => /\.[cm]?ts$/.test(file))
  .flatMap((file) => edgesOf(file, readFileSync(file, "utf8")))

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
    expect(runtimeAlchemyEdges(edges)).toEqual([])
  })

  it("lets adapters run Alchemy's Drizzle and SQL helpers but not its resources", () => {
    const file = resolve(src, "Adapters/Fixture.ts")
    expect(
      runtimeAlchemyEdges(
        edgesOf(file, 'import * as Drizzle from "alchemy/Drizzle/Postgres"'),
      ),
    ).toEqual([])
    expect(
      runtimeAlchemyEdges(
        edgesOf(file, 'import * as Cloudflare from "alchemy/Cloudflare"'),
      ),
    ).toEqual([
      {
        file: "Adapters/Fixture.ts",
        typeOnly: false,
        specifier: "alchemy/Cloudflare",
      },
    ])
  })

  it("allows import type but rejects inline type imports of Alchemy in adapters", () => {
    const file = resolve(src, "Adapters/Fixture.ts")
    expect(
      runtimeAlchemyEdges(
        edgesOf(file, 'import type { X } from "alchemy/Cloudflare/R2"'),
      ),
    ).toEqual([])
    expect(
      runtimeAlchemyEdges(
        edgesOf(file, 'import { type X } from "alchemy/Cloudflare/R2"'),
      ),
    ).toEqual([
      {
        file: "Adapters/Fixture.ts",
        typeOnly: false,
        specifier: "alchemy/Cloudflare/R2",
      },
    ])
  })
})
