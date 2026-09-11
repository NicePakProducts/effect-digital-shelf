import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

/**
 * The import boundary of core, as decided on the map's Core layout ticket:
 * repositories see only domain, Drizzle, Effect and Sql/; Sql/ sees no
 * feature; only features open transactions; nothing in src/ reaches the test
 * folder or a sibling package that depends on core.
 */
const src = resolve(import.meta.dirname, "../src")

const files = walk(src).filter((file) => file.endsWith(".ts"))

const test = resolve(import.meta.dirname)

const testFiles = walk(test).filter((file) => file.endsWith(".ts"))

describe("core import boundary", () => {
  it("repositories import only domain, Drizzle, Effect and Sql/", () => {
    expect(
      violations(
        files.filter(under("repositories")),
        (specifier) => isExternal(specifier) || specifier.startsWith("Sql/"),
      ),
    ).toEqual([])
  })

  it("repositories never open a transaction", () => {
    expect(
      files
        .filter(under("repositories"))
        .filter((file) =>
          /\.transaction\(|withTransaction/.test(readFileSync(file, "utf8")),
        )
        .map((file) => relative(src, file)),
    ).toEqual([])
  })

  it("Sql/ knows no feature", () => {
    expect(
      violations(
        files.filter(under("Sql")),
        (specifier) => isExternal(specifier) || specifier.startsWith("Sql/"),
      ),
    ).toEqual([])
  })

  it("src/ never imports the test folder or a package that depends on core", () => {
    expect(
      violations(
        files,
        (specifier) =>
          !/(^|\/)test(\/|$)/.test(specifier) &&
          !specifier.startsWith("@digital-shelf/core/test") &&
          !specifier.startsWith("@digital-shelf/infra") &&
          !specifier.startsWith("@digital-shelf/api"),
      ),
    ).toEqual([])
  })
})

describe("test seams", () => {
  /**
   * Repositories are never faked (ADR 0008). A bounded syntactic scan: it rejects
   * Layer.succeed, Layer.effect, Context.make and Effect.provideService calls
   * providing a *Repo under test/, and allows XRepo.layer and XRepo.layer.pipe(...).
   * It does not see through aliases, re-exports or helper-produced layers;
   * review carries the rest.
   */
  it("tests provide a repository only through its real layer", () => {
    expect(
      testFiles.flatMap((file) =>
        Array.from(
          readFileSync(file, "utf8").matchAll(
            /\b(?:Layer\.(?:succeed|effect)|Context\.make|Effect\.provideService)\(\s*(\w+Repo)\b/g,
          ),
          (match) => `${relative(test, file)}: ${match[0]}`,
        ),
      ),
    ).toEqual([])
  })
})

function walk(dir: string): ReadonlyArray<string> {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)

    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

const importsOf = (file: string): ReadonlyArray<string> =>
  Array.from(
    readFileSync(file, "utf8").matchAll(
      /^(?:(?:import|export)\b[^;]*?\bfrom\s+|import\s+)["']([^"']+)["']/gm,
    ),
    (match) => match[1]!,
  ).map((specifier) =>
    specifier.startsWith(".")
      ? relative(src, resolve(dirname(file), specifier))
      : specifier,
  )

const isExternal = (specifier: string) =>
  /^(effect(\/|$)|drizzle-orm(\/|$)|@digital-shelf\/domain\/)/.test(specifier)

const under = (folder: string) => (file: string) =>
  relative(src, file).split("/").includes(folder)

const violations = (
  selected: ReadonlyArray<string>,
  allowed: (specifier: string) => boolean,
) =>
  selected.flatMap((file) =>
    importsOf(file)
      .filter((specifier) => !allowed(specifier))
      .map((specifier) => `${relative(src, file)} -> ${specifier}`),
  )
