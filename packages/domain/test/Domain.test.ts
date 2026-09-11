import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Option, Schema } from "effect"
import {
  Brand,
  BrandInsert,
  BrandUpdate,
} from "@digital-shelf/domain/Catalog/Brand"
import { CreateListing } from "@digital-shelf/domain/Catalog/ListingManagement"
import { BrandNotFound } from "@digital-shelf/domain/Catalog/Errors"
import { Retailer } from "@digital-shelf/domain/Catalog/Retailer"
import * as Scrape from "@digital-shelf/domain/Scraping/Scrape"
import { BrandId } from "@digital-shelf/domain/Shared/Ids"
import { brands, scrapes } from "@digital-shelf/domain/Sql/index"

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const epoch = DateTime.toDate(DateTime.makeUnsafe(0))

// Compile-time proof that the derived entity's encoded side is the row
// Drizzle hands over (every selected row decodes, every encoded insert is a
// valid insert value), so a refine that drifts from its table fails
// `vp check` here rather than at runtime.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

type Assignable<From, To> = [From] extends [To] ? true : false

const rowsDecodeAsBrand: Assignable<
  typeof brands.$inferSelect,
  typeof Brand.Encoded
> = true

const brandKeysMatchRow: Assignable<
  Mutable<typeof Brand.Encoded>,
  typeof brands.$inferSelect
> = true

const brandInsertsAreRows: Assignable<
  typeof BrandInsert.Encoded,
  typeof brands.$inferInsert
> = true

// Scrape's error code is a `text` column narrowed by a CHECK, so the row type
// is wider than the entity: only the keys-match direction holds statically.
const scrapeKeysMatchRow: Assignable<
  Mutable<typeof Scrape.Scrape.Encoded>,
  typeof scrapes.$inferSelect
> = true

describe("derived entities", () => {
  it("decodes a Brand row into the domain vocabulary", () => {
    expect(rowsDecodeAsBrand && brandKeysMatchRow && brandInsertsAreRows).toBe(
      true,
    )

    const brand = Schema.decodeUnknownSync(Brand)({
      id: uuid(1),
      name: "Gaia",
      paused: false,
      createdAt: epoch,
      updatedAt: epoch,
    })

    expect(brand.id).toBe(Schema.decodeUnknownSync(BrandId)(uuid(1)))
    expect(DateTime.isDateTime(brand.createdAt)).toBe(true)
  })

  it("rejects an id that is not a UUID", () => {
    expect(() =>
      Schema.decodeUnknownSync(Brand)({
        id: "b1",
        name: "Gaia",
        paused: false,
        createdAt: epoch,
        updatedAt: epoch,
      }),
    ).toThrow()
  })

  it("lets an insert omit the id and timestamps the table defaults", () => {
    const row = Schema.encodeSync(BrandInsert)({ name: "Gaia", paused: false })
    expect(row).toEqual({ name: "Gaia", paused: false })
    expect(Schema.decodeUnknownSync(BrandUpdate)({ paused: true })).toEqual({
      paused: true,
    })
  })

  it("only admits a canonical Retailer domain", () => {
    const row = (domain: string) => ({
      id: uuid(2),
      name: "Chemist Warehouse",
      domain,
      paused: false,
      scrapeMode: "basic",
      scrapeCountry: "Australia",
      listingExtractPrompt: "l",
      pageExtractPrompt: "p",
      createdAt: epoch,
      updatedAt: epoch,
    })

    expect(
      Schema.decodeUnknownSync(Retailer)(row("chemistwarehouse.com.au")).domain,
    ).toBe("chemistwarehouse.com.au")
    expect(() =>
      Schema.decodeUnknownSync(Retailer)(
        row("https://www.chemistwarehouse.com.au/"),
      ),
    ).toThrow()
  })
})

describe("Scrape", () => {
  const row = (listingId: string | null, pageId: string | null) => ({
    id: uuid(3),
    listingId,
    pageId,
    mode: "basic",
    country: null,
    status: "pending",
    rootSpanId: "0123456789abcdef",
    requestUrl: "https://chemistwarehouse.com.au/bath-wash",
    requestHeaders: null,
    startedAt: null,
    finishedAt: null,
    errorCode: null,
    errorMessage: null,
    htmlR2Key: null,
    rawR2Key: null,
    finalUrl: null,
    statusCode: null,
    responseHeaders: null,
    cookies: null,
    innerText: null,
    userAgent: null,
    ipInfo: null,
    type: null,
    session: null,
    attempts: null,
    createdAt: epoch,
    updatedAt: epoch,
  })

  it("surfaces NULL as None and derives the Parent", () => {
    expect(scrapeKeysMatchRow).toBe(true)
    const scrape = Schema.decodeUnknownSync(Scrape.Scrape)(row(uuid(4), null))
    expect(Option.isNone(scrape.startedAt)).toBe(true)
    expect(Scrape.parent(scrape)).toEqual({
      _tag: "Listing",
      listingId: uuid(4),
    })
    const page = Schema.decodeUnknownSync(Scrape.Scrape)(row(null, uuid(5)))
    expect(Scrape.parent(page)).toEqual({ _tag: "Page", pageId: uuid(5) })
    expect(Scrape.parentKind(Scrape.parent(page))).toBe("page")
  })

  it("refuses a row with both Parents or neither", () => {
    expect(() =>
      Schema.decodeUnknownSync(Scrape.Scrape)(row(uuid(4), uuid(5))),
    ).toThrow(/exactly one Parent/)
    expect(() =>
      Schema.decodeUnknownSync(Scrape.Scrape)(row(null, null)),
    ).toThrow(/exactly one Parent/)
  })

  it("refuses an error code outside the vocabulary", () => {
    expect(() =>
      Schema.decodeUnknownSync(Scrape.Scrape)({
        ...row(uuid(4), null),
        errorCode: "schema_mismatch",
      }),
    ).toThrow()
  })
})

describe("commands and errors", () => {
  it("validates a Listing command", () => {
    expect(() =>
      Schema.decodeUnknownSync(CreateListing)({
        productId: uuid(6),
        retailerId: uuid(7),
        url: "not a url",
      }),
    ).toThrow(/absolute URL/)

    const command = Schema.decodeUnknownSync(CreateListing)({
      productId: uuid(6),
      retailerId: uuid(7),
      url: "https://chemistwarehouse.com.au/bath-wash",
      variantIds: [uuid(8)],
    })

    expect(command.variantIds).toEqual([uuid(8)])
  })

  it.effect("raises a business error core can catch by tag", () =>
    Effect.gen(function* () {
      const brandId = Schema.decodeUnknownSync(BrandId)(uuid(1))

      const recovered = yield* Effect.fail(new BrandNotFound({ brandId })).pipe(
        Effect.catchTag("BrandNotFound", (error) =>
          Effect.succeed(error.brandId),
        ),
      )

      expect(recovered).toBe(brandId)

      const encoded = Schema.encodeSync(BrandNotFound)(
        new BrandNotFound({ brandId }),
      )

      expect(encoded).toEqual({ _tag: "BrandNotFound", brandId })
    }),
  )
})
