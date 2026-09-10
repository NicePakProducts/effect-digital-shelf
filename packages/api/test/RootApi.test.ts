import { format } from "vite-plus/fmt"
import { describe, expect, it } from "@effect/vitest"
import * as OpenApi from "effect/unstable/httpapi/OpenApi"
import { RootApi } from "../src/RootApi.ts"

const spec = OpenApi.fromApi(RootApi)
const codesOf = (responses: object) => Object.keys(responses).sort()
describe("RootApi", () => {
  it("matches the OpenAPI contract snapshot", async () => {
    // Use the repo formatter so vp check --fix cannot invalidate this JSON snapshot.
    const formatted = await format(
      "RootApi.openapi.json",
      JSON.stringify(spec, null, 2),
      { printWidth: 80 },
    )
    expect(formatted.errors).toEqual([])
    await expect(formatted.code).toMatchFileSnapshot(
      "./__snapshots__/RootApi.openapi.json",
    )
  })
  it("mounts the six Catalog groups and the two scraping groups under /api/v1", () => {
    expect(spec.info).toMatchObject({ title: "Digital Shelf", version: "1" })
    const paths = Object.keys(spec.paths)
    expect(paths).toHaveLength(27)
    expect(paths.every((path) => path.startsWith("/api/v1/"))).toBe(true)
    expect(paths.some((path) => path.startsWith("/api/v1/auth"))).toBe(false)
    expect(spec.paths["/api/v1/variants/{id}/impact"]).toBeUndefined()
    for (const path of [
      "/api/v1/scrapes",
      "/api/v1/scrapes/bulk",
      "/api/v1/scrapes/{id}",
      "/api/v1/scrapes/{id}/content",
      "/api/v1/extractions",
      "/api/v1/extractions/bulk",
      "/api/v1/extractions/{id}",
      "/api/v1/listings/{id}/latest-extraction",
      "/api/v1/pages/{id}/latest-extraction",
      "/api/v1/products/{id}/latest-extractions",
    ])
      expect(spec.paths[path]).toBeDefined()
  })
  it("declares the exact success and business-error statuses, plus authentication", () => {
    for (const [group, createErrors, updateErrors] of [
      ["brands", [], [404]],
      ["products", [404], [404]],
      ["variants", [404, 409], [404, 409]],
      ["retailers", [409, 422], [404, 409, 422]],
      ["listings", [404, 422], [404, 422]],
      ["pages", [404, 409, 422], [404, 422]],
    ] as const) {
      const collection = spec.paths[`/api/v1/${group}`]!
      const item = spec.paths[`/api/v1/${group}/{id}`]!
      expect(codesOf(collection.get!.responses)).toEqual(["200", "401"])
      expect(codesOf(collection.post!.responses)).toEqual(
        ["201", "401", ...createErrors.map(String)].sort(),
      )
      expect(codesOf(item.get!.responses)).toEqual(["200", "401", "404"])
      expect(codesOf(item.patch!.responses)).toEqual(
        ["200", "401", ...updateErrors.map(String)].sort(),
      )
      expect(codesOf(item.delete!.responses)).toEqual(["200", "401", "404"])
      if (group !== "variants")
        expect(
          codesOf(spec.paths[`/api/v1/${group}/{id}/impact`]!.get!.responses),
        ).toEqual(["200", "401", "404"])
    }
    expect(JSON.stringify(spec)).not.toContain("SqlError")
  })
  it("answers dispatch with 202 and names its refusals", () => {
    expect(codesOf(spec.paths["/api/v1/scrapes"]!.post!.responses)).toEqual([
      "202",
      "401",
      "404",
      "409",
    ])
    expect(
      codesOf(spec.paths["/api/v1/scrapes/bulk"]!.post!.responses),
    ).toEqual(["202", "401", "404"])
    expect(codesOf(spec.paths["/api/v1/extractions"]!.post!.responses)).toEqual(
      ["202", "401", "404", "409", "422"],
    )
    expect(
      codesOf(spec.paths["/api/v1/extractions/bulk"]!.post!.responses),
    ).toEqual(["202", "401", "404"])
    expect(
      codesOf(
        spec.paths["/api/v1/products/{id}/latest-extractions"]!.get!.responses,
      ),
    ).toEqual(["200", "401", "404"])
    // DispatchOutcome is core's own vocabulary and never reaches the wire.
    expect(JSON.stringify(spec)).not.toContain("in-flight-skip")
    expect(JSON.stringify(spec)).not.toContain("SqlError")
  })
  it("keeps the R2 keys off the Scrape projection and streams content as text", () => {
    const row = JSON.stringify(
      spec.paths["/api/v1/scrapes/{id}"]!.get!.responses[200],
    )
    expect(row).not.toContain("htmlR2Key")
    expect(row).not.toContain("rawR2Key")
    expect(row).toContain("rootSpanId")
    expect(
      spec.paths["/api/v1/scrapes/{id}/content"]!.get!.responses[200],
    ).toMatchObject({ content: { "text/plain; charset=utf-8": {} } })
    expect(
      JSON.stringify(spec.paths["/api/v1/scrapes/{id}/content"]!.get!),
    ).not.toContain("text/html")
    expect(
      codesOf(spec.paths["/api/v1/scrapes/{id}/content"]!.get!.responses),
    ).toEqual(["200", "401", "404"])
  })
  it("offers optional cursor and limit on the paginated lists", () => {
    expect(spec.components!.schemas!["Limit"]).toMatchObject({
      type: "string",
      pattern: "^(100|[1-9][0-9]?)$",
      description: "rows per page, 1 to 100; 50 when omitted",
    })
    expect(spec.components!.schemas!["Cursor"]).toMatchObject({
      type: "string",
      pattern:
        "^\\d{1,13}:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      description: "a page cursor, `<createdAtMillis>:<id>`",
    })
    for (const path of ["/api/v1/scrapes", "/api/v1/extractions"]) {
      const parameters = spec.paths[path]!.get!.parameters!
      const named = (name: string) =>
        parameters.find(
          (parameter) => "name" in parameter && parameter.name === name,
        )
      expect(named("limit")).toEqual({
        name: "limit",
        in: "query",
        schema: { $ref: "#/components/schemas/Limit" },
        required: false,
      })
      expect(named("cursor")).toEqual({
        name: "cursor",
        in: "query",
        schema: { $ref: "#/components/schemas/Cursor" },
        required: false,
      })
      expect(JSON.stringify(spec.paths[path]!.get!.responses[200])).toContain(
        '"required":["items","nextCursor"]',
      )
    }
    expect(
      (spec.paths["/api/v1/scrapes"]!.get!.parameters ?? []).flatMap(
        (parameter) => ("name" in parameter ? [parameter.name] : []),
      ),
    ).toEqual(["listingId", "pageId", "status", "cursor", "limit"])
    expect(
      (spec.paths["/api/v1/extractions"]!.get!.parameters ?? []).flatMap(
        (parameter) => ("name" in parameter ? [parameter.name] : []),
      ),
    ).toEqual(["scrapeId", "status", "cursor", "limit"])
  })
  it("describes every timestamp as a date-time string and nullable lastScrapedAt", () => {
    for (const group of [
      "brands",
      "products",
      "variants",
      "retailers",
      "listings",
      "pages",
    ]) {
      const row = spec.paths[`/api/v1/${group}/{id}`]!.get!.responses[200]
      expect(row).toMatchObject({
        content: {
          "application/json": {
            schema: {
              properties: {
                createdAt: { type: "string", format: "date-time" },
                updatedAt: { type: "string", format: "date-time" },
              },
            },
          },
        },
      })
      if (group === "listings" || group === "pages")
        expect(row).toMatchObject({
          content: {
            "application/json": {
              schema: {
                properties: {
                  lastScrapedAt: {
                    anyOf: [
                      { type: "string", format: "date-time" },
                      { type: "null" },
                    ],
                  },
                  effectivePaused: { type: "boolean" },
                  combinedStatus: {
                    enum: ["failed", "pending", "running", "success", "none"],
                  },
                },
              },
            },
          },
        })
    }
  })
  it("returns the five nonnegative CascadeImpact counts from remove and impact", () => {
    const count = { type: "integer", minimum: 0 }
    const schema = {
      type: "object",
      properties: {
        products: count,
        variants: count,
        listings: count,
        pages: count,
        scrapes: count,
      },
      required: ["products", "variants", "listings", "pages", "scrapes"],
      additionalProperties: false,
    }
    for (const group of [
      "brands",
      "products",
      "variants",
      "retailers",
      "listings",
      "pages",
    ]) {
      expect(
        spec.paths[`/api/v1/${group}/{id}`]!.delete!.responses[200],
      ).toMatchObject({ content: { "application/json": { schema } } })
      if (group !== "variants")
        expect(
          spec.paths[`/api/v1/${group}/{id}/impact`]!.get!.responses[200],
        ).toMatchObject({ content: { "application/json": { schema } } })
    }
  })
  it("names the exact domain errors for creates and updates", () => {
    for (const [group, creates, updates] of [
      ["brands", [], ["BrandNotFound"]],
      ["products", ["BrandNotFound"], ["ProductNotFound"]],
      [
        "variants",
        ["ProductNotFound", "DuplicateVariantName"],
        ["VariantNotFound", "DuplicateVariantName"],
      ],
      [
        "retailers",
        ["InvalidRetailerDomain", "RetailerDomainTaken"],
        [
          "RetailerNotFound",
          "InvalidRetailerDomain",
          "RetailerDomainTaken",
          "UrlHostMismatch",
        ],
      ],
      [
        "listings",
        [
          "ProductNotFound",
          "RetailerNotFound",
          "VariantNotInProduct",
          "UrlHostMismatch",
        ],
        ["ListingNotFound", "VariantNotInProduct", "UrlHostMismatch"],
      ],
      [
        "pages",
        [
          "BrandNotFound",
          "RetailerNotFound",
          "PageAlreadyExists",
          "UrlHostMismatch",
        ],
        ["PageNotFound", "UrlHostMismatch"],
      ],
    ] as const) {
      const names = (responses: object) =>
        Array.from(
          JSON.stringify(responses).matchAll(
            /#\/components\/schemas\/([A-Za-z]+)Encoded/g,
          ),
          (match) => match[1]!,
        ).sort()
      expect(names(spec.paths[`/api/v1/${group}`]!.post!.responses)).toEqual(
        [...creates].sort(),
      )
      expect(
        names(spec.paths[`/api/v1/${group}/{id}`]!.patch!.responses),
      ).toEqual([...updates].sort())
    }
  })
})
