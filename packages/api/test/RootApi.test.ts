import { format } from "vite-plus/fmt"
import { describe, expect, it } from "@effect/vitest"
import * as OpenApi from "effect/unstable/httpapi/OpenApi"
import { RootApi } from "../src/RootApi.ts"

const spec = OpenApi.fromApi(RootApi)
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
  it("mounts only the six Catalog groups under /api/v1", () => {
    expect(spec.info).toMatchObject({ title: "Digital Shelf", version: "1" })
    const paths = Object.keys(spec.paths)
    expect(paths).toHaveLength(17)
    expect(paths.every((path) => path.startsWith("/api/v1/"))).toBe(true)
    expect(paths.some((path) => path.startsWith("/api/v1/auth"))).toBe(false)
    expect(spec.paths["/api/v1/variants/{id}/impact"]).toBeUndefined()
    expect(spec.paths["/api/v1/scrapes"]).toBeUndefined()
    expect(spec.paths["/api/v1/extractions"]).toBeUndefined()
  })
  it("declares the exact success and business-error statuses, plus authentication", () => {
    for (const [group, createErrors, updateErrors] of [
      ["brands", [], [404]],
      ["products", [404], [404]],
      ["variants", [404, 409], [404, 409]],
      ["retailers", [409, 422], [404, 409, 422]],
      ["listings", [404, 422], [404, 422]],
      ["pages", [404, 409], [404]],
    ] as const) {
      const collection = spec.paths[`/api/v1/${group}`]!
      const item = spec.paths[`/api/v1/${group}/{id}`]!
      const codes = (responses: object) => Object.keys(responses).sort()
      expect(codes(collection.get!.responses)).toEqual(["200", "401"])
      expect(codes(collection.post!.responses)).toEqual(
        ["201", "401", ...createErrors.map(String)].sort(),
      )
      expect(codes(item.get!.responses)).toEqual(["200", "401", "404"])
      expect(codes(item.patch!.responses)).toEqual(
        ["200", "401", ...updateErrors.map(String)].sort(),
      )
      expect(codes(item.delete!.responses)).toEqual(["200", "401", "404"])
      if (group !== "variants")
        expect(
          codes(spec.paths[`/api/v1/${group}/{id}/impact`]!.get!.responses),
        ).toEqual(["200", "401", "404"])
    }
    expect(JSON.stringify(spec)).not.toContain("SqlError")
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
        ["RetailerNotFound", "InvalidRetailerDomain", "RetailerDomainTaken"],
      ],
      [
        "listings",
        ["ProductNotFound", "RetailerNotFound", "VariantNotInProduct"],
        ["ListingNotFound", "VariantNotInProduct"],
      ],
      [
        "pages",
        ["BrandNotFound", "RetailerNotFound", "PageAlreadyExists"],
        ["PageNotFound"],
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
