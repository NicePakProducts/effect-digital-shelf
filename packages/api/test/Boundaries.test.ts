import { describe, expect, it } from "@effect/vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"

const src = resolve(import.meta.dirname, "../src")
const packages = resolve(src, "../..")
const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((entry) => {
    const file = join(dir, entry)
    return statSync(file).isDirectory() ? walk(file) : [file]
  })
const files = walk(src).filter((file) => file.endsWith(".ts"))
const classify = (file: string): "contract" | "execution" | "unknown" => {
  const name = relative(src, file)
  if (
    name === "Api.ts" ||
    name.endsWith("Handlers.ts") ||
    ["Auth/CurrentUserMiddleware.ts", "Auth/AuthRoutes.ts"].includes(name)
  )
    return "execution"
  // index.ts is package metadata only, and is checked as a contract too.
  if (
    name === "index.ts" ||
    name.endsWith("Api.ts") ||
    name.endsWith("Wire.ts") ||
    name === "Auth/Security.ts" ||
    /(^|\/)Errors\.ts$/.test(name)
  )
    return "contract"
  return "unknown"
}
const importsOf = (file: string): ReadonlyArray<string> =>
  Array.from(
    readFileSync(file, "utf8").matchAll(
      /^(?:(?:import|export)\b[^;]*?\bfrom\s+|import\s+)["']([^"']+)["']/gm,
    ),
    (match) => match[1]!,
  )
const sourceOf = (from: string, specifier: string): string | undefined => {
  let path: string
  if (specifier.startsWith(".")) path = resolve(dirname(from), specifier)
  else if (specifier.startsWith("@digital-shelf/")) {
    const [pkg, ...parts] = specifier.slice("@digital-shelf/".length).split("/")
    path = resolve(packages, pkg!, "src", parts.join("/") || "index")
  } else return undefined
  if (path.endsWith(".ts")) return path
  return existsSync(`${path}.ts`) ? `${path}.ts` : join(path, "index.ts")
}
/** Follow re-exports and domain imports as well as direct api imports. */
const violations = (
  roots: ReadonlyArray<string>,
  readImports = importsOf,
): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const errors: string[] = []
  const visit = (file: string, chain: ReadonlyArray<string>) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const specifier of readImports(file)) {
      const target = sourceOf(file, specifier)
      const next = [...chain, specifier]
      if (
        /^@digital-shelf\/core(?:\/|$)/.test(specifier) ||
        /(^|\/)test(\/|$)/.test(specifier) ||
        (target !== undefined &&
          ((!target.startsWith(src + "/") &&
            !target.startsWith(resolve(packages, "domain/src") + "/")) ||
            /(^|\/)test(\/|$)/.test(relative(packages, target)) ||
            (target.startsWith(src + "/") && classify(target) !== "contract")))
      ) {
        errors.push(next.join(" -> "))
      } else if (target !== undefined) {
        visit(target, next)
      } else if (
        !/^effect(?:\/|$)/.test(specifier) &&
        !(
          file.startsWith(resolve(packages, "domain") + "/") &&
          /^drizzle-orm(?:\/|$)/.test(specifier)
        )
      ) {
        errors.push(next.join(" -> "))
      }
    }
  }
  for (const root of roots) visit(root, [relative(src, root)])
  return errors
}

describe("api contract boundary", () => {
  it("classifies every source module as contract or execution", () => {
    expect(
      files
        .filter((file) => classify(file) === "unknown")
        .map((file) => relative(src, file)),
    ).toEqual([])
  })
  it("keeps the complete contract import graph free of core, tests and execution modules", () => {
    expect(
      violations(files.filter((file) => classify(file) === "contract")),
    ).toEqual([])
  })
  it("rejects a synthetic import of core", () => {
    expect(
      violations([join(src, "RootApi.ts")], () => [
        "@digital-shelf/core/Catalog/Brands",
      ]),
    ).toEqual(["RootApi.ts -> @digital-shelf/core/Catalog/Brands"])
  })
  it("rejects forbidden imports hidden behind a contract re-export", () => {
    for (const forbidden of [
      "@digital-shelf/core/Catalog/Brands",
      "@digital-shelf/infra/Adapters/Db",
      "./BrandsHandlers.ts",
      "../../test/Fixture.ts",
      "../Auth/CurrentUserMiddleware.ts",
      "../Api.ts",
      "../Auth/AuthRoutes.ts",
    ]) {
      expect(
        violations([join(src, "RootApi.ts")], (file) =>
          file === join(src, "RootApi.ts")
            ? ["./Catalog/BrandsWire.ts"]
            : [forbidden],
        ),
      ).toHaveLength(1)
    }
  })
})
