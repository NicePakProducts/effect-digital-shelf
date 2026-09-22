import { describe, expect, it } from "@effect/vitest"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import * as Schema from "effect/Schema"

const root = resolve(import.meta.dirname, "../../..")

const protocol = resolve(root, "packages/protocol/src")

const schema = resolve(root, "packages/schema/src")

const client = resolve(root, "packages/client/src")

const server = resolve(root, "apps/server/src")

const web = resolve(root, "apps/web/src")

const manifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      exports: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
)

const workspaces = ["packages", "apps"].flatMap((folder) =>
  readdirSync(join(root, folder)).flatMap((name) => {
    const directory = join(root, folder, name)
    const file = join(directory, "package.json")

    return existsSync(file)
      ? [{ directory, ...manifest(readFileSync(file, "utf8")) }]
      : []
  }),
)

const walk = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir).flatMap((entry) => {
    const file = join(dir, entry)

    return statSync(file).isDirectory() ? walk(file) : [file]
  })

const importsOf = (file: string): ReadonlyArray<string> =>
  Array.from(
    readFileSync(file, "utf8").matchAll(
      /(?:\b(?:import|export)\b[^;]*?\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)["']([^"']+)["']/g,
    ),
    (match) => match[1]!,
  )

/** Resolve relative paths and the actual explicit workspace exports, not name prefixes. */
const sourceOf = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith(".")) {
    const path = resolve(dirname(from), specifier)

    return (
      [path, `${path}.ts`, `${path}.tsx`, join(path, "index.ts")].find(
        (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
      ) ?? path
    )
  }

  if (!specifier.startsWith("@app/")) return undefined

  const workspace = workspaces.find(
    (candidate) =>
      specifier === candidate.name ||
      specifier.startsWith(candidate.name + "/"),
  )

  const path =
    workspace?.exports?.["." + specifier.slice(workspace.name.length)]

  if (workspace === undefined || path === undefined)
    throw new Error(`Unexported import: ${specifier}`)

  return resolve(workspace.directory, path)
}

const inside = (file: string, directory: string) =>
  file.startsWith(directory + "/")

const violations = (
  roots: ReadonlyArray<string>,
  allowed: ReadonlyArray<string>,
  effectOnly: boolean,
  readImports = importsOf,
): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const errors: string[] = []

  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)

    for (const specifier of readImports(file)) {
      const target = sourceOf(file, specifier)

      if (target === undefined) {
        if (effectOnly && !/^effect(?:\/|$)/.test(specifier))
          errors.push(`${relative(root, file)} -> ${specifier}`)
        continue
      }

      if (!allowed.some((directory) => inside(target, directory))) {
        errors.push(`${relative(root, file)} -> ${specifier}`)
        continue
      }

      visit(target)
    }
  }

  for (const file of roots) visit(file)

  return errors
}

const sources = (directory: string) =>
  walk(directory).filter((file) => /\.tsx?$/.test(file))

describe("HTTP package boundaries", () => {
  it("shared schemas stay flat data modules without operation error definitions", () => {
    for (const file of sources(schema)) {
      expect(dirname(file)).toBe(schema)
      expect(readFileSync(file, "utf8")).not.toMatch(/\bTaggedError\b/)
    }
  })
  it("keeps the complete protocol graph within schema and Effect", () => {
    expect(violations(sources(protocol), [protocol, schema], true)).toEqual([])
  })
  it("keeps the browser graph within web, client, protocol and schema", () => {
    expect(
      violations(
        sources(web).concat(sources(client)),
        [web, client, protocol, schema],
        false,
      ),
    ).toEqual([])
    expect(
      sources(web).flatMap((file) =>
        importsOf(file).filter(
          (specifier) =>
            /^@app\//.test(specifier) &&
            !/^@app\/(?:client|schema)(?:\/|$)/.test(specifier),
        ),
      ),
    ).toEqual([])
  })
  it("handlers consume only explicit public core exports, never database or repositories", () => {
    for (const file of sources(join(server, "handlers")).concat(
      sources(join(server, "auth")),
    )) {
      for (const specifier of importsOf(file)) {
        const target = sourceOf(file, specifier)

        if (target === undefined) continue
        expect(target).not.toContain("/repository.ts")
        expect(target).not.toContain("/packages/db/")
        expect(target).not.toContain("/test/")
        expect(
          [server, protocol, schema, resolve(root, "packages/core/src")].some(
            (directory) => inside(target, directory),
          ),
        ).toBe(true)
      }
    }

    // HTTP assembly owns the existing health query, but not business defaults.
    expect(
      importsOf(join(server, "http.ts")).filter(
        (specifier) =>
          specifier.startsWith("@app/core") &&
          specifier !== "@app/core/Sql/Errors",
      ),
    ).toEqual([])
  })
  it("rejects forbidden imports hidden behind relative re-exports", () => {
    const entry = join(protocol, "api.ts")
    const bridge = join(protocol, "products.ts")

    for (const forbidden of [
      "@app/core/products",
      "@app/db/adapter",
      "../../../apps/server/src/handlers/products.ts",
      "../../../apps/server/src/Worker.ts",
    ]) {
      expect(
        violations([entry], [protocol, schema], true, (file) =>
          file === entry
            ? ["./products.ts"]
            : file === bridge
              ? [forbidden]
              : [],
        ),
      ).toHaveLength(1)
    }
  })
  it("does not expose app HTTP implementation as library exports", () => {
    expect(
      workspaces.find((workspace) => workspace.name === "@app/server")?.exports,
    ).toBeUndefined()
    expect(() =>
      sourceOf(join(protocol, "api.ts"), "@app/server/http"),
    ).toThrow("Unexported import")
  })
  it("does not export wildcard paths from HTTP packages", () => {
    for (const pkg of ["protocol", "client"]) {
      const exports = manifest(
        readFileSync(resolve(root, "packages", pkg, "package.json"), "utf8"),
      ).exports

      expect(
        Object.keys(exports ?? {}).filter((key) => key.includes("*")),
      ).toEqual([])
    }
  })
})
