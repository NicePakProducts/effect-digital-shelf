import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import {
  exportsOf,
  importsOf,
  root,
  sourceOf,
  sources,
  workspaceOf,
  workspaces,
} from "./SourceImports"

// Bounded to the project's class-service and const-reference declaration forms.
const serviceKeysOf = (source: string) => [
  ...Array.from(
    source.matchAll(
      /\bclass\s+(\w+)\s+extends\s+(?:Context|HttpApiMiddleware)\.Service<[\s\S]*?>\s*\(\s*\)\s*\(\s*["']([^"']+)["']/g,
    ),
    (match) => ({ symbol: match[1]!, key: match[2]! }),
  ),
  ...Array.from(
    source.matchAll(
      /\bconst\s+(\w+)\s*=\s*Context\.Reference<[\s\S]*?>\s*\(\s*["']([^"']+)["']/g,
    ),
    (match) => ({ symbol: match[1]!, key: match[2]! }),
  ),
]

interface Directions {
  readonly [name: string]: ReadonlyArray<string>
}

const directions: Directions = {
  schema: [],
  db: ["schema"],
  core: ["db", "schema"],
  protocol: ["schema"],
  server: ["core", "db", "infra", "protocol", "schema"],
  client: ["protocol", "schema"],
  infra: ["core", "db", "schema"],
  web: ["client", "schema"],
}

const shortName = (name: string) => name.replace("@app/", "")

const allowedDirection = (from: string, to: string) =>
  from === to || directions[shortName(from)]?.includes(shortName(to)) === true

function violations(
  file: string,
  source: string,
  aliases?: Readonly<Record<string, ReadonlyArray<string>>>,
) {
  const owner = workspaceOf(file)!

  return importsOf(source).flatMap((specifier) => {
    const target = sourceOf(file, specifier, aliases)

    if (target === undefined) {
      const browser = ["web", "client", "protocol", "schema"].includes(
        shortName(owner.name),
      )

      const serverOnly =
        /^(?:node:|alchemy(?:\/|$)|drizzle-(?:orm|kit)(?:\/|$)|pg$|@electric-sql\/pglite(?:\/|$)|@cloudflare\/playwright(?:\/|$)|@better-auth\/|@effect\/(?:sql-|platform-node|platform-bun))/.test(
          specifier,
        ) ||
        (specifier.startsWith("better-auth") &&
          !/^better-auth\/client(?:\/|$)/.test(specifier))

      const effectOnly = ["protocol", "schema"].includes(shortName(owner.name))

      return (browser && serverOnly) ||
        (effectOnly && !/^effect(?:\/|$)/.test(specifier))
        ? [`${relative(root, file)} -> ${specifier}`]
        : []
    }

    const dependency = workspaceOf(target)

    const publicPath =
      dependency === owner ||
      exportsOf(dependency?.directory ?? "").includes(target)

    const allowed =
      dependency !== undefined && allowedDirection(owner.name, dependency.name)

    const testPath = /\/test\//.test(target)

    const tableBypass =
      target.startsWith(join(root, "packages/db/src/schema") + "/") &&
      !["db", "core"].includes(shortName(owner.name))

    const secondDb =
      shortName(owner.name) === "core" &&
      target === join(root, "packages/db/src/adapter.ts")

    const dbContract = file === join(root, "packages/db/src/db.ts")

    return !allowed ||
      !publicPath ||
      testPath ||
      tableBypass ||
      secondDb ||
      dbContract
      ? [`${relative(root, file)} -> ${relative(root, target)}`]
      : []
  })
}

describe("resolved workspace boundaries", () => {
  it("enforces declared production dependency directions, including db devDependencies", () => {
    for (const workspace of workspaces) {
      const dependencies =
        workspace.name === "@app/db"
          ? { ...workspace.dependencies, ...workspace.devDependencies }
          : workspace.dependencies

      expect(
        Object.keys(dependencies ?? {}).filter(
          (name) =>
            name.startsWith("@app/") && !allowedDirection(workspace.name, name),
        ),
        workspace.name,
      ).toEqual([])
    }
  })

  it("resolves every source edge including re-exports, dynamic imports and aliases", () => {
    expect(
      workspaces
        .flatMap((workspace) => sources(join(workspace.directory, "src")))
        .flatMap((file) => violations(file, readFileSync(file, "utf8"))),
    ).toEqual([])
  }, 30_000)

  it("relative source imports and re-exports omit TypeScript extensions", () => {
    const files = workspaces
      .flatMap((workspace) => sources(join(workspace.directory, "src")))
      .concat(join(root, "alchemy.run.ts"), join(root, "vite.config.ts"))

    expect(
      files.flatMap((file) =>
        importsOf(readFileSync(file, "utf8"))
          .filter(
            (specifier) =>
              specifier.startsWith(".") && /\.tsx?$/.test(specifier),
          )
          .map((specifier) => `${relative(root, file)} -> ${specifier}`),
      ),
    ).toEqual([])
  })

  it("extensionless paths select source files ahead of same-named feature directories", () => {
    const file = join(root, "packages/core/src/listings.ts")

    for (const module of ["products", "products/variants", "products/errors"]) {
      expect(sourceOf(file, "./" + module)).toBe(
        join(root, "packages/core/src", module + ".ts"),
      )
    }

    expect(
      sourceOf(join(root, "packages/core/src/products/errors.ts"), "./errors"),
    ).toBe(join(root, "packages/core/src/products/errors.ts"))
  })

  it("exports explicit existing paths, never private persistence or a wildcard", () => {
    for (const workspace of workspaces) {
      for (const [key, value] of Object.entries(workspace.exports ?? {})) {
        expect(key + value).not.toContain("*")
        expect(value).not.toMatch(/\/(?:repository|parents|transitions)\.ts$/)
        expect(
          sourceOf(
            join(workspace.directory, "src/index.ts"),
            workspace.name + key.slice(1),
          ),
        ).toBe(resolve(workspace.directory, value))
      }
    }
  })

  it("rejects relative, re-export, dynamic and TS alias bypasses", () => {
    const protocol = join(root, "packages/protocol/src/api.ts")
    const server = join(root, "apps/server/src/handlers/products.ts")
    const web = join(root, "apps/web/src/main.tsx")
    const core = join(root, "packages/core/src/products/repository.ts")

    for (const source of [
      'export * from "../../core/src/products.ts"',
      'export * from "../../core/src/products"',
      'const hidden = import("../../core/src/products")',
      'const hidden = import("@app/db/adapter")',
      'import type { Service } from "../../../apps/server/src/handlers/products.ts"',
    ])
      expect(violations(protocol, source)).toHaveLength(1)

    expect(
      violations(
        server,
        'import { ProductsRepo } from "../../../../packages/core/src/products/repository.ts"',
      ),
    ).toHaveLength(1)
    expect(
      violations(server, 'export * from "private"', { private: [core] }),
    ).toHaveLength(1)
    expect(
      violations(
        server,
        'import { ProductsRepo } from "../../../../packages/core/src/products/repository"',
      ),
    ).toHaveLength(1)
    expect(
      violations(server, 'export * from "@app/core/products"', {
        "@app/core/products": [core],
      }),
    ).toHaveLength(1)
    expect(violations(web, 'export * from "@app/protocol/api"')).toHaveLength(1)
    expect(violations(web, 'const hidden = import("node:fs")')).toHaveLength(1)
    const client = join(root, "packages/client/src/auth.ts")

    for (const specifier of [
      "better-auth",
      "better-auth/plugins",
      "@electric-sql/pglite",
      "@effect/sql-pg/PgClient",
    ]) {
      expect(violations(client, `export * from "${specifier}"`)).toHaveLength(1)
    }

    expect(violations(client, 'export * from "better-auth/client"')).toEqual([])
    expect(() => sourceOf(server, "@app/core/products/repository")).toThrow(
      "Unexported import",
    )
    expect(
      violations(
        join(root, "apps/server/src/http.ts"),
        'import { ProductsTable } from "@app/db/schema/products"',
      ),
    ).toHaveLength(1)
    expect(
      violations(core, 'import * as Adapter from "@app/db/adapter"'),
    ).toHaveLength(1)
    expect(allowedDirection("@app/db", "@app/core")).toBe(false)
    expect(allowedDirection("@app/listings", "@app/core")).toBe(false)
  })

  it("service and reference keys use their current workspace and module identity", () => {
    for (const workspace of workspaces) {
      const files = ["src", "test"].flatMap((folder) =>
        sources(join(workspace.directory, folder)),
      )

      // This boundary's fixtures intentionally quote invalid declarations.
      for (const file of files.filter(
        (file) => file !== import.meta.filename,
      )) {
        const source = readFileSync(file, "utf8")
        const keys = serviceKeysOf(source)
        expect(keys.length, relative(root, file)).toBe(
          Array.from(
            source.matchAll(
              /\b(?:Context|HttpApiMiddleware)\.(?:Service|Reference)\s*</g,
            ),
          ).length,
        )
        const local = relative(workspace.directory, file)

        const module =
          workspace.exports?.["."] === "./" + local
            ? workspace.name
            : workspace.name +
              "/" +
              local.replace(/^src\//, "").replace(/\.tsx?$/, "")

        for (const entry of keys) {
          expect(
            [module, module + "/" + entry.symbol],
            relative(root, file),
          ).toContain(entry.key)
        }
      }
    }
  })

  it("service, middleware and reference keys never collide across production or tests", () => {
    const keys = workspaces
      .flatMap((workspace) =>
        ["src", "test"].flatMap((folder) =>
          sources(join(workspace.directory, folder)),
        ),
      )
      .filter((file) => file !== import.meta.filename)
      .flatMap((file) => serviceKeysOf(readFileSync(file, "utf8")))
      .map((entry) => entry.key)

    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("recognizes context classes, references and middleware without treating error tags as service keys", () => {
    expect(
      serviceKeysOf(`
      class Service extends Context.Service<Service, Interface>()("./Catalog/Retailers.ts") {}
      const RootTraceId = Context.Reference<Option.Option<string>>("../Scraping/RootTraceId.ts", { defaultValue: Option.none })
      class CurrentUserMiddleware extends HttpApiMiddleware.Service<CurrentUserMiddleware, { provides: CurrentUser }>()("@app/api/Auth/CurrentUserMiddleware", { error: [] }) {}
      class NotFound extends Data.TaggedError("ProductNotFound")<{ readonly productId: Product.Id }> {}
    `),
    ).toEqual([
      { symbol: "Service", key: "./Catalog/Retailers.ts" },
      {
        symbol: "CurrentUserMiddleware",
        key: "@app/api/Auth/CurrentUserMiddleware",
      },
      { symbol: "RootTraceId", key: "../Scraping/RootTraceId.ts" },
    ])
  })

  it("keeps every transitive browser workspace edge closed", () => {
    // Every reached module is checked, not only imports spelled in the browser entry.
    const visited = new Set<string>()
    const errors: string[] = []

    const visit = (file: string) => {
      if (visited.has(file)) return
      visited.add(file)
      const source = readFileSync(file, "utf8")

      errors.push(...violations(file, source))

      for (const specifier of importsOf(source)) {
        const target = sourceOf(file, specifier)

        if (target === undefined) continue
        const owner = workspaceOf(target)

        if (
          !owner ||
          !["web", "client", "protocol", "schema"].includes(
            shortName(owner.name),
          )
        ) {
          errors.push(`${relative(root, file)} -> ${specifier}`)
          continue
        }

        visit(target)
      }
    }

    for (const file of sources(join(root, "apps/web/src"))) visit(file)
    expect(errors).toEqual([])
    expect(visited.has(join(root, "packages/client/src/auth.ts"))).toBe(true)
  })
})
