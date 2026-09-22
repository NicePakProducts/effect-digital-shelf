import * as Schema from "effect/Schema"
import * as SourceImports from "./SourceImports"
import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { basename, join, relative, resolve } from "node:path"

/**
 * The import boundary of core, as decided on the map's Core layout ticket:
 * repositories see only schema, db, Drizzle, Effect and Sql/; Sql/ sees no
 * feature; only features open transactions; nothing in src/ reaches the test
 * folder or a sibling package that depends on core.
 */
const src = resolve(import.meta.dirname, "../src")

const files = walk(src).filter((file) => file.endsWith(".ts"))

const test = resolve(import.meta.dirname)

// This rule's own documentation may quote forbidden forms.
const testFiles = walk(test).filter(
  (file) => file.endsWith(".ts") && basename(file) !== "Boundaries.test.ts",
)

describe("core import boundary", () => {
  it("repositories import only schema, db, Drizzle, Effect and Sql/", () => {
    expect(
      violations(
        files.filter(isRepository),
        (specifier, file) =>
          isExternal(specifier) ||
          specifier.startsWith("Sql/") ||
          specifier === relative(src, file),
      ),
    ).toEqual([])
  })

  it("repositories never open a transaction", () => {
    expect(
      files
        .filter(isRepository)
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
          !specifier.startsWith("@app/core/test") &&
          !specifier.startsWith("@app/infra") &&
          !/^@app\/(?:protocol|server|client)(?:\/|$)/.test(specifier),
      ),
    ).toEqual([])
  })
})

// Exact implementation consumers, not an all-Catalog or all-Scraping allowance.
interface Ownership {
  readonly [owner: string]: ReadonlyArray<string>
}

const repositoryConsumers: Ownership = {
  "brands/repository.ts": ["brands.ts"],
  "products/repository.ts": ["products.ts", "products/variants.ts"],
  "products/variants/repository.ts": ["products/variants.ts"],
  "retailers/repository.ts": ["retailers.ts"],
  "listings/repository.ts": ["listings.ts"],
  "pages/repository.ts": ["pages.ts"],
  "cascade/repository.ts": ["cascade.ts"],
  "scrapes/parents/repository.ts": ["scrapes.ts", "scrapes/parents.ts"],
  "scrapes/repository.ts": [
    "scrapes.ts",
    "scrapes/extractions.ts",
    "scrapes/runner.ts",
    "scrapes/extractions/runner.ts",
    "scrapes/transitions.ts",
    "scrapes/sweeps.ts",
  ],
  "scrapes/extractions/repository.ts": [
    "scrapes/extractions.ts",
    "scrapes/runner.ts",
    "scrapes/extractions/runner.ts",
    "scrapes/transitions.ts",
    "scrapes/sweeps.ts",
  ],
}

// These established read models own their joins. Cross-table writes are prohibited below.
const readTables: Ownership = {
  "brands/repository.ts": ["BrandsTable"],
  "products/repository.ts": ["ProductsTable"],
  "products/variants/repository.ts": ["ProductVariantsTable"],
  "retailers/repository.ts": ["RetailersTable", "ListingsTable", "PagesTable"],
  "listings/repository.ts": [
    "ListingsTable",
    "ListingVariantsTable",
    "ProductsTable",
    "ProductVariantsTable",
    "BrandsTable",
    "RetailersTable",
    "ScrapesTable",
    "ExtractionsTable",
  ],
  "pages/repository.ts": [
    "PagesTable",
    "BrandsTable",
    "RetailersTable",
    "ScrapesTable",
    "ExtractionsTable",
  ],
  "cascade/repository.ts": [
    "ProductsTable",
    "ProductVariantsTable",
    "ListingsTable",
    "PagesTable",
    "ScrapesTable",
  ],
  "scrapes/parents/repository.ts": [
    "BrandsTable",
    "ProductsTable",
    "RetailersTable",
    "ListingsTable",
    "PagesTable",
    "ScrapesTable",
  ],
  "scrapes/repository.ts": ["ScrapesTable"],
  "scrapes/extractions/repository.ts": [
    "ExtractionsTable",
    "ScrapesTable",
    "ListingsTable",
    "PagesTable",
  ],
}

const writeTables: Ownership = {
  "brands/repository.ts": ["BrandsTable"],
  "products/repository.ts": ["ProductsTable"],
  "products/variants/repository.ts": ["ProductVariantsTable"],
  "retailers/repository.ts": ["RetailersTable"],
  "listings/repository.ts": ["ListingsTable", "ListingVariantsTable"],
  "pages/repository.ts": ["PagesTable"],
  "scrapes/repository.ts": ["ScrapesTable"],
  "scrapes/extractions/repository.ts": ["ExtractionsTable"],
}

const ownsRepository = (specifier: string, file: string) =>
  !specifier.endsWith("/repository.ts") ||
  specifier === relative(src, file) ||
  (repositoryConsumers[specifier]?.includes(relative(src, file)) ?? false)

describe("feature ownership", () => {
  it("rejects private repo and table bypasses after resolving source paths", () => {
    const file = resolve(src, "listings.ts")

    for (const source of [
      'import { ProductsRepo } from "./products/repository.ts"',
      'export * from "./products/repository.js"',
      'const hidden = import("./products/repository.ts")',
    ]) {
      expect(
        importsOf(file, source).filter(
          (specifier) => !ownsRepository(specifier, file),
        ),
      ).toEqual(["products/repository.ts"])
    }

    expect(
      importsOf(file, 'export * from "../../db/src/schema/products.ts"'),
    ).toEqual(["@app/db/schema/products"])
    expect(
      ownsRepository(
        "products/repository.ts",
        resolve(src, "products/variants.ts"),
      ),
    ).toBe(true)
  })
  it("private repositories have only explicitly enumerated consumers", () => {
    expect(violations(files, ownsRepository)).toEqual([])
  })
  it("repositories access exactly their owned tables and established read projections", () => {
    for (const file of files.filter(isRepository)) {
      const tables = tableImports(file)

      expect(
        tables.map((binding) => binding.table).sort(),
        relative(src, file),
      ).toEqual([...(readTables[relative(src, file)] ?? [])].sort())

      const writes = Array.from(
        readFileSync(file, "utf8").matchAll(
          /\.(?:insert|update|delete)\((\w+)\)/g,
        ),
        (match) => match[1]!,
      )

      expect(
        writes.filter(
          (local) =>
            !writeTables[relative(src, file)]?.includes(
              tables.find((binding) => binding.local === local)?.table ?? local,
            ),
        ),
        relative(src, file),
      ).toEqual([])
    }
  })
  it("colocated tables do not broaden repository read permissions", () => {
    const file = resolve(src, "products/repository.ts")
    const allowed = readTables["products/repository.ts"]!

    for (const source of [
      'import { ProductVariantsTable } from "@app/db/schema/products"',
      'import { ProductVariantsTable as Hidden } from "../../../db/src/schema/products.ts"',
      'import * as Tables from "@app/db/schema/products"',
      'const hidden = import("@app/db/schema/products")',
      'export { ProductVariantsTable } from "@app/db/schema/products"',
    ]) {
      expect(
        tableImports(file, source).filter(
          (binding) => !allowed.includes(binding.table),
        ),
      ).toHaveLength(1)
    }

    expect(
      tableImports(
        file,
        'import { ProductsTable as Owned } from "@app/db/schema/products"',
      ),
    ).toEqual([{ table: "ProductsTable", local: "Owned" }])
  })
  it("features do not bypass repositories with table imports", () => {
    expect(
      violations(
        files.filter(
          (file) =>
            !isRepository(file) && relative(src, file) !== "auth/adapter.ts",
        ),
        (specifier) => !specifier.startsWith("@app/db/schema"),
      ),
    ).toEqual([])
  })
  it("the auth adapter can reach only auth tables", () => {
    expect(
      importsOf(resolve(src, "auth/adapter.ts")).filter((specifier) =>
        specifier.startsWith("@app/db/schema"),
      ),
    ).toEqual(["@app/db/schema/auth"])
  })

  it("exports never expose private repositories, helpers or wildcard paths", () => {
    const manifest = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
      ),
    )(readFileSync(resolve(src, "../package.json"), "utf8"))

    expect(
      Object.entries(manifest.exports).filter(
        ([key, value]) =>
          key.includes("*") ||
          value.endsWith("/repository.ts") ||
          value.endsWith("/errors.ts") ||
          value === "./src/scrapes/transitions.ts",
      ),
    ).toEqual([])
  })
  it("handlers, apps and adapters never import private repositories through any path", () => {
    const consumers = ["../../infra/src", "../../../apps/server/src"]
      .flatMap((folder) => walk(resolve(import.meta.dirname, folder)))
      .filter((file) => file.endsWith(".ts"))

    expect(
      violations(
        consumers,
        (specifier) => !specifier.endsWith("/repository.ts"),
      ),
    ).toEqual([])
  })

  it("public capabilities do not re-export private persistence", () => {
    const publicFiles = SourceImports.exportsOf(resolve(src, "..")).filter(
      (file) => file.startsWith(src + "/"),
    )

    const privateExports = (file: string, source: string) =>
      Array.from(
        source.matchAll(
          /\bexport\s+(?:\*|\{[^}]*\})[^;]*?\bfrom\s*["']([^"']+)["']/g,
        ),
        (match) => match[1]!,
      ).filter((specifier) =>
        SourceImports.sourceOf(file, specifier)?.endsWith("/repository.ts"),
      )

    expect(
      publicFiles.flatMap((file) =>
        privateExports(file, readFileSync(file, "utf8")),
      ),
    ).toEqual([])
    expect(
      privateExports(
        resolve(src, "products.ts"),
        'export { ProductsRepo } from "./products/repository.ts"',
      ),
    ).toEqual(["./products/repository.ts"])
  })

  it("public capabilities use named files and application assembly does not live in core", () => {
    expect(files.filter((file) => file.endsWith("/index.ts"))).toEqual([])
    expect(
      files.filter((file) =>
        ["Layers.ts", "composition.ts"].includes(relative(src, file)),
      ),
    ).toEqual([])
  })
})

describe("business error ownership", () => {
  const owners = [
    "auth",
    "brands",
    "products",
    "products/variants",
    "retailers",
    "listings",
    "pages",
    "scrapes",
    "scrapes/extractions",
    "scrapes/lifecycle",
  ]

  it("error modules depend only on shared data and Effect", () => {
    expect(
      violations(
        owners.map((owner) => resolve(src, owner, "errors.ts")),
        (specifier, file) =>
          specifier === relative(src, file) ||
          /^(?:effect(?:\/|$)|@app\/schema\/)/.test(specifier),
      ),
    ).toEqual([])
  })

  it("capability implementations do not define public business error classes", () => {
    for (const owner of owners) {
      expect(readFileSync(resolve(src, owner + ".ts"), "utf8")).not.toMatch(
        /export\s+class\s+\w+\s+extends\s+(?:Data|Schema)\.TaggedError/,
      )
    }
  })

  it("ProductVariants obtains parent errors without importing the Products implementation", () => {
    const imports = importsOf(resolve(src, "products/variants.ts"))
    expect(imports).toContain("products/errors.ts")
    expect(imports).not.toContain("products.ts")
  })
})

describe("test seams", () => {
  /**
   * Repositories are never faked (ADR 0008). A bounded syntactic scan: it rejects
   * Layer.succeed, Layer.effect, Layer.sync, Layer.mock, Context.make and
   * Effect.provideService calls providing a *Repo under test/, and allows
   * XRepo.layer and XRepo.layer.pipe(...).
   * It does not see through aliases, re-exports or helper-produced layers;
   * review carries the rest.
   */
  it("tests provide a repository only through its real layer", () => {
    expect(
      testFiles.flatMap((file) =>
        Array.from(
          readFileSync(file, "utf8").matchAll(
            /\b(?:Layer\.(?:succeed|effect|sync|mock)|Context\.make|Effect\.provideService)\(\s*(\w+Repo)\b/g,
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

const importsOf = (
  file: string,
  source = readFileSync(file, "utf8"),
): ReadonlyArray<string> =>
  SourceImports.importsOf(source).map((specifier) => {
    const target = SourceImports.sourceOf(file, specifier)

    if (target === undefined) return specifier

    if (target.startsWith(src + "/")) return relative(src, target)
    const tables = resolve(src, "../../db/src/schema")

    if (target.startsWith(tables + "/")) {
      return "@app/db/schema/" + relative(tables, target).replace(/\.ts$/, "")
    }

    const workspace = SourceImports.workspaceOf(target)

    return workspace === undefined
      ? target
      : workspace.name + "/" + relative(workspace.directory, target)
  })

// Named bindings keep the exact table boundary when several tables share a module.
// Namespace, re-export and dynamic table imports are rejected rather than guessed.
function tableImports(file: string, source = readFileSync(file, "utf8")) {
  const named = Array.from(
    source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g),
  )

  return SourceImports.importsOf(source).flatMap((specifier) => {
    const target = SourceImports.sourceOf(file, specifier)

    if (!target?.startsWith(resolve(src, "../../db/src/schema") + "/"))
      return []
    const declarations = named.filter((match) => match[2] === specifier)

    if (declarations.length !== 1)
      return [{ table: "<non-named table import>", local: "" }]

    return declarations[0]![1]!
      .split(",")
      .map((binding) => binding.trim())
      .filter(Boolean)
      .map((binding) => {
        const names = binding.replace(/^type\s+/, "").split(/\s+as\s+/)

        return { table: names[0]!, local: names[1] ?? names[0]! }
      })
  })
}

const isExternal = (specifier: string) =>
  /^(effect(\/|$)|drizzle-orm(\/|$)|@app\/(?:schema\/|db(?:\/|$)))/.test(
    specifier,
  )

const isRepository = (file: string) => basename(file) === "repository.ts"

const under = (folder: string) => (file: string) =>
  relative(src, file).split("/").includes(folder)

const violations = (
  selected: ReadonlyArray<string>,
  allowed: (specifier: string, file: string) => boolean,
) =>
  selected.flatMap((file) =>
    importsOf(file)
      .filter((specifier) => !allowed(specifier, file))
      .map((specifier) => `${relative(src, file)} -> ${specifier}`),
  )
