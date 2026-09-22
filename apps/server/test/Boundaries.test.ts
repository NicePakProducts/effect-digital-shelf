import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"

const src = resolve(import.meta.dirname, "../src")

const edges = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts"))
  .flatMap((entry) => {
    const file = resolve(src, entry)
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

describe("server composition boundary", () => {
  it("assembles every existing handler group by its directly exported Layer name", () => {
    const inventory = [
      ["brands.ts", "brands", "BrandsHandlersLayer"],
      ["products.ts", "products", "ProductsHandlersLayer"],
      ["products/variants.ts", "variants", "ProductVariantsHandlersLayer"],
      ["retailers.ts", "retailers", "RetailersHandlersLayer"],
      ["listings.ts", "listings", "ListingsHandlersLayer"],
      ["pages.ts", "pages", "PagesHandlersLayer"],
      ["scrapes.ts", "scrapes", "ScrapesHandlersLayer"],
      ["scrapes/extractions.ts", "extractions", "ExtractionsHandlersLayer"],
      ["ping.ts", "ping", "PingHandlersLayer"],
    ] as const

    const assembly = readFileSync(resolve(src, "http.ts"), "utf8")

    expect(
      readdirSync(resolve(src, "handlers"), {
        recursive: true,
        encoding: "utf8",
      })
        .filter((file) => file.endsWith(".ts"))
        .sort(),
    ).toEqual(inventory.map(([file]) => file).sort())

    for (const [file, group, name] of inventory) {
      const source = readFileSync(resolve(src, "handlers", file), "utf8")

      expect(source).toMatch(
        new RegExp(
          `export const ${name} = HttpApiBuilder\\.group\\(\\s*Api,\\s*"${group}"`,
        ),
      )
      expect(source).not.toMatch(/export const layer\b/)
      expect(assembly).toContain(
        `import { ${name} } from "./handlers/${file.replace(/\.ts$/, "")}"`,
      )
    }
  })

  it("never imports test helpers", () => {
    expect(
      edges.filter(({ specifier }) => /(?:^|\/)test(?:\/|$)/.test(specifier)),
    ).toEqual([])
  })
})
