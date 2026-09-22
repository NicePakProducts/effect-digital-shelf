import { describe, expect, it } from "@effect/vitest"
import { DateTime, Option, Schema } from "effect"
import { Brand } from "@app/schema/brand"
import { Listing } from "@app/schema/listing"
import { Retailer } from "@app/schema/retailer"
import { Scrape } from "@app/schema/scrape"
import { BrandId, ListingId, PageId } from "@app/schema/ids"
import { BrandsTable, ScrapesTable } from "@app/db/schema"

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const epoch = DateTime.toDate(DateTime.makeUnsafe(0))

// Compile-time proof that the explicit entity's encoded side is the row
// Drizzle hands over (every selected row decodes, every encoded insert is a
// valid insert value), so a refine that drifts from its table fails
// `vp check` here rather than at runtime.
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

type Assignable<From, To> = [From] extends [To] ? true : false

const rowsDecodeAsBrand: Assignable<
  typeof BrandsTable.$inferSelect,
  typeof Brand.Info.Encoded
> = true

const brandKeysMatchRow: Assignable<
  Mutable<typeof Brand.Info.Encoded>,
  typeof BrandsTable.$inferSelect
> = true

const brandInsertsAreRows: Assignable<
  typeof Brand.Insert.Encoded,
  typeof BrandsTable.$inferInsert
> = true

// Scrape's error code is a `text` column narrowed by a CHECK, so the row type
// is wider than the entity: only the keys-match direction holds statically.
const scrapeKeysMatchRow: Assignable<
  Mutable<typeof Scrape.Info.Encoded>,
  typeof ScrapesTable.$inferSelect
> = true

describe("explicit entities", () => {
  it("decodes a Brand row into the domain vocabulary", () => {
    expect(rowsDecodeAsBrand && brandKeysMatchRow && brandInsertsAreRows).toBe(
      true,
    )

    const brand = Schema.decodeUnknownSync(Brand.Info)({
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
      Schema.decodeUnknownSync(Brand.Info)({
        id: "b1",
        name: "Gaia",
        paused: false,
        createdAt: epoch,
        updatedAt: epoch,
      }),
    ).toThrow()
  })

  it("lets an insert omit the id and timestamps the table defaults", () => {
    const row = Schema.encodeSync(Brand.Insert)({ name: "Gaia", paused: false })
    expect(row).toEqual({ name: "Gaia", paused: false })
    expect(Schema.decodeUnknownSync(Brand.UpdateRow)({ paused: true })).toEqual(
      {
        paused: true,
      },
    )
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
      Schema.decodeUnknownSync(Retailer.Info)(row("chemistwarehouse.com.au"))
        .domain,
    ).toBe("chemistwarehouse.com.au")
    expect(() =>
      Schema.decodeUnknownSync(Retailer.Info)(
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
    const scrape = Schema.decodeUnknownSync(Scrape.Info)(row(uuid(4), null))
    expect(Option.isNone(scrape.startedAt)).toBe(true)
    expect(Scrape.parent(scrape)).toEqual(
      Scrape.Parent.members[0].make({
        listingId: ListingId.make(uuid(4)),
      }),
    )
    const page = Schema.decodeUnknownSync(Scrape.Info)(row(null, uuid(5)))
    expect(Scrape.parent(page)).toEqual(
      Scrape.Parent.members[1].make({ pageId: PageId.make(uuid(5)) }),
    )
    expect(Scrape.parentKind(Scrape.parent(page))).toBe("page")
  })

  it("refuses a row with both Parents or neither", () => {
    expect(() =>
      Schema.decodeUnknownSync(Scrape.Info)(row(uuid(4), uuid(5))),
    ).toThrow(/exactly one Parent/)
    expect(() =>
      Schema.decodeUnknownSync(Scrape.Info)(row(null, null)),
    ).toThrow(/exactly one Parent/)
  })

  it("refuses an error code outside the vocabulary", () => {
    expect(() =>
      Schema.decodeUnknownSync(Scrape.Info)({
        ...row(uuid(4), null),
        errorCode: "schema_mismatch",
      }),
    ).toThrow()
  })
})

describe("commands and errors", () => {
  it("validates a Listing command", () => {
    expect(() =>
      Schema.decodeUnknownSync(Listing.Create)({
        productId: uuid(6),
        retailerId: uuid(7),
        url: "not a url",
      }),
    ).toThrow(/absolute URL/)

    const command = Schema.decodeUnknownSync(Listing.Create)({
      productId: uuid(6),
      retailerId: uuid(7),
      url: "https://chemistwarehouse.com.au/bath-wash",
      variantIds: [uuid(8)],
    })

    expect(command.variantIds).toEqual([uuid(8)])
  })
})
