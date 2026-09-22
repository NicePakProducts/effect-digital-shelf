import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import * as Schema from "effect/Schema"

export const root = resolve(import.meta.dirname, "../../..")

const strings = Schema.Record(Schema.String, Schema.String)

const manifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      exports: Schema.optional(strings),
      dependencies: Schema.optional(strings),
      devDependencies: Schema.optional(strings),
    }),
  ),
)

export const workspaces = ["packages", "apps"].flatMap((folder) =>
  readdirSync(join(root, folder)).flatMap((name) => {
    const directory = join(root, folder, name)
    const file = join(directory, "package.json")

    return existsSync(file)
      ? [{ directory, ...manifest(readFileSync(file, "utf8")) }]
      : []
  }),
)

export const sources = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory).flatMap((name) => {
    const file = join(directory, name)

    return statSync(file).isDirectory()
      ? sources(file)
      : /\.tsx?$/.test(file)
        ? [file]
        : []
  })

/** Literal imports, re-exports, side effects, import types and dynamic imports. */
export const importsOf = (source: string): ReadonlyArray<string> =>
  Array.from(
    source.matchAll(
      /(?:\b(?:import|export)\b[^;]*?\bfrom\s*|\b(?:import|require)\s*\(\s*|\bimport\s*)["']([^"']+)["']/g,
    ),
    (match) => match[1]!,
  )

export const workspaceOf = (file: string) =>
  workspaces.find((workspace) => file.startsWith(workspace.directory + "/"))

export const exportsOf = (directory: string) =>
  Object.values(
    workspaces.find((workspace) => workspace.directory === directory)
      ?.exports ?? {},
  ).map((path) => resolve(directory, path))

const paths = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Record(Schema.String, Schema.Array(Schema.String)),
  ),
)

// tsconfig's paths object is JSON; comments elsewhere in JSONC are immaterial.
const aliasesOf = (config: string) =>
  existsSync(config)
    ? paths(
        readFileSync(config, "utf8")
          .match(/"paths"\s*:\s*(\{[^}]*\})/)?.[1]
          ?.replace(/^\s*\/\/.*$/gm, "") ?? "{}",
      )
    : {}

export const sourceOf = (
  from: string,
  specifier: string,
  aliases = {
    ...aliasesOf(join(root, "tsconfig.json")),
    ...aliasesOf(join(workspaceOf(from)?.directory ?? root, "tsconfig.json")),
  },
): string | undefined => {
  if (specifier.startsWith("."))
    return requireSource(resolve(dirname(from), specifier))

  const workspace = workspaces.find(
    (candidate) =>
      specifier === candidate.name ||
      specifier.startsWith(candidate.name + "/"),
  )

  const exported =
    workspace?.exports?.["." + specifier.slice(workspace.name.length)]

  // Export visibility still applies when TS paths resolve workspace source directly.
  if (workspace !== undefined && exported === undefined)
    throw new Error(`Unexported import: ${specifier}`)

  for (const [alias, targets] of Object.entries(aliases).sort(
    ([a], [b]) => b.replace("*", "").length - a.replace("*", "").length,
  )) {
    const [prefix, suffix] = alias.split("*")

    const matches =
      suffix === undefined
        ? specifier === prefix
        : specifier.startsWith(prefix!) && specifier.endsWith(suffix)

    if (!matches) continue

    const middle =
      suffix === undefined
        ? ""
        : specifier.slice(prefix!.length, specifier.length - suffix.length)

    const base = Object.hasOwn(aliasesOf(join(root, "tsconfig.json")), alias)
      ? root
      : (workspaceOf(from)?.directory ?? root)

    for (const target of targets) {
      const file = sourceFile(resolve(base, target.replace("*", middle)))

      if (file !== undefined) return file
    }
  }

  if (workspace !== undefined && exported !== undefined)
    return requireSource(resolve(workspace.directory, exported))

  if (specifier.startsWith("@app/"))
    throw new Error(`Unknown workspace: ${specifier}`)

  return undefined
}

function sourceFile(path: string) {
  const stem = path.replace(/\.js$/, ".ts")

  return [stem, `${stem}.ts`, `${stem}.tsx`, join(stem, "index.ts")].find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  )
}

function requireSource(path: string) {
  const file = sourceFile(path)

  if (file === undefined) throw new Error(`Unresolved source: ${path}`)

  return file
}
