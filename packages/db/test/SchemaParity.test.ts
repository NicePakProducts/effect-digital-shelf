import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { PGlite } from "@electric-sql/pglite"
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/effect-schema"
import { drizzle } from "drizzle-orm/pglite"
import { getColumns } from "drizzle-orm"
import { DateTime, Option, Schema } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import * as Tables from "@app/db/schema"
import {
  BrandId,
  ProductId,
  VariantId,
  RetailerId,
  ListingId,
  PageId,
  ScrapeId,
  ExtractionId,
} from "@app/schema/ids"
import { Timestamp, Url, Json, nullable } from "@app/schema/refine"
import { Retailer } from "@app/schema/retailer"
import { Execution } from "@app/schema/execution"
import { ScrapeEnvelope } from "@app/schema/scrape-envelope"
import {
  ScrapeErrorCode,
  ExtractionErrorCode,
} from "@app/schema/scraping-vocabulary"
import { Brand } from "@app/schema/brand"
import { Product } from "@app/schema/product"
import { ProductVariant } from "@app/schema/product-variant"
import { Listing } from "@app/schema/listing"
import { Page } from "@app/schema/page"
import { Scrape } from "@app/schema/scrape"
import { Extraction } from "@app/schema/extraction"
// Original pre-extraction refinement maps are intentionally independent of the
// explicit application fields. Drizzle still supplies all unrefined fields,
// including its permissive undefined optionals and int32 bounds.

const pglite = new PGlite()

const db = drizzle({ client: pglite })

const migrationDir = join(import.meta.dirname, "../migrations")

const first = <A>(values: readonly A[]): A => {
  const value = values[0]

  if (value === undefined) throw new Error("seed insert returned no row")

  return value
}

const seed = async () => {
  const brands = first(
    await db.insert(Tables.BrandsTable).values({ name: "Gaia" }).returning(),
  )

  const products = first(
    await db
      .insert(Tables.ProductsTable)
      .values({ brandId: brands.id, name: "Bath Wash" })
      .returning(),
  )

  const variants = first(
    await db
      .insert(Tables.ProductVariantsTable)
      .values({ productId: products.id, name: "250ml" })
      .returning(),
  )

  const retailers = first(
    await db
      .insert(Tables.RetailersTable)
      .values({
        name: "Shop",
        domain: "shop.example",
        scrapeMode: "basic",
        scrapeCountry: "Australia",
        listingExtractPrompt: "l",
        pageExtractPrompt: "p",
      })
      .returning(),
  )

  const listings = first(
    await db
      .insert(Tables.ListingsTable)
      .values({
        productId: products.id,
        retailerId: retailers.id,
        url: "https://shop.example/product",
        cadence: "monthly",
      })
      .returning(),
  )

  const listingVariants = first(
    await db
      .insert(Tables.ListingVariantsTable)
      .values({ listingId: listings.id, variantId: variants.id })
      .returning(),
  )

  const pages = first(
    await db
      .insert(Tables.PagesTable)
      .values({
        brandId: brands.id,
        retailerId: retailers.id,
        url: "https://shop.example/brand",
        cadence: "daily",
      })
      .returning(),
  )

  const scrapes = first(
    await db
      .insert(Tables.ScrapesTable)
      .values({
        listingId: listings.id,
        mode: "basic",
        status: "success",
        rootSpanId: "0123456789abcdef",
        requestUrl: listings.url,
      })
      .returning(),
  )

  const extractions = first(
    await db
      .insert(Tables.ExtractionsTable)
      .values({
        scrapeId: scrapes.id,
        attempt: 1,
        status: "pending",
        promptKind: "listing",
        promptSnapshot: "l",
        model: "model",
      })
      .returning(),
  )

  return {
    brands,
    products,
    variants,
    retailers,
    listings,
    listingVariants,
    pages,
    scrapes,
    extractions,
  }
}

// Lazy seed: apply the committed history before asking Drizzle for real rows.
const rows: {
  [K in keyof Awaited<ReturnType<typeof seed>>]?: Awaited<
    ReturnType<typeof seed>
  >[K]
} = {}

beforeAll(async () => {
  for (const migration of readdirSync(migrationDir).sort()) {
    const source = readFileSync(
      join(migrationDir, migration, "migration.sql"),
      "utf8",
    )

    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim().length > 0) await pglite.exec(statement)
    }
  }

  Object.assign(rows, await seed())
})

afterAll(() => pglite.close())

const values = [
  undefined,
  null,
  "",
  "basic",
  "monthly",
  "pending",
  "listing",
  "unknown",
  "0123456789abcdef",
  "not-a-uuid",
  "https://www.Shop.example/x?utm_source=test",
  0,
  1,
  -1,
  1.5,
  -2147483648,
  2147483647,
  -2147483649,
  2147483648,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  true,
  false,
  {},
  [],
  { price: 9.99 },
  { accept: "text/html" },
  DateTime.toDate(DateTime.makeUnsafe(0)),
]

// Field-level parity uses the pre-existing parent rule in both paths. The
// invalid both/neither-parent cases are independently exercised in Entities.
const exactlyOneParent = Schema.makeFilter(
  (row: {
    readonly listingId: Option.Option<unknown>
    readonly pageId: Option.Option<unknown>
  }) =>
    Option.isSome(row.listingId) !== Option.isSome(row.pageId)
      ? undefined
      : "a Scrape has exactly one Parent: a Listing or a Page",
  { identifier: "ExactlyOneParent" },
)

const compare = <A>(
  application: Schema.ConstraintCodec<unknown, unknown>,
  reference: Schema.ConstraintCodec<unknown, unknown>,
  input: A,
) => {
  const actual = Schema.decodeUnknownOption(application)(input)
  const expected = Schema.decodeUnknownOption(reference)(input)
  expect(actual).toEqual(expected)

  if (Option.isSome(actual) && Option.isSome(expected)) {
    expect(Schema.encodeUnknownSync(application)(actual.value)).toEqual(
      Schema.encodeUnknownSync(reference)(expected.value),
    )
  }
}

const referenceBrand = createSelectSchema(Tables.BrandsTable, {
  id: BrandId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

const referenceBrandInsert = createInsertSchema(Tables.BrandsTable, {
  id: Schema.optionalKey(BrandId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceBrandUpdate = createUpdateSchema(Tables.BrandsTable, {
  id: Schema.optionalKey(BrandId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceProduct = createSelectSchema(Tables.ProductsTable, {
  id: ProductId,
  brandId: BrandId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

const referenceProductInsert = createInsertSchema(Tables.ProductsTable, {
  id: Schema.optionalKey(ProductId),
  brandId: BrandId,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceProductUpdate = createUpdateSchema(Tables.ProductsTable, {
  id: Schema.optionalKey(ProductId),
  brandId: Schema.optionalKey(BrandId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceVariant = createSelectSchema(Tables.ProductVariantsTable, {
  id: VariantId,
  productId: ProductId,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

const referenceVariantInsert = createInsertSchema(Tables.ProductVariantsTable, {
  id: Schema.optionalKey(VariantId),
  productId: ProductId,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceVariantUpdate = createUpdateSchema(Tables.ProductVariantsTable, {
  id: Schema.optionalKey(VariantId),
  productId: Schema.optionalKey(ProductId),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceRetailer = createSelectSchema(Tables.RetailersTable, {
  id: RetailerId,
  domain: Retailer.Domain,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

const referenceRetailerInsert = createInsertSchema(Tables.RetailersTable, {
  id: Schema.optionalKey(RetailerId),
  domain: Retailer.Domain,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceRetailerUpdate = createUpdateSchema(Tables.RetailersTable, {
  id: Schema.optionalKey(RetailerId),
  domain: Schema.optionalKey(Retailer.Domain),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceListing = createSelectSchema(Tables.ListingsTable, {
  id: ListingId,
  productId: ProductId,
  retailerId: RetailerId,
  url: Url,
  lastScrapedAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

const referenceListingInsert = createInsertSchema(Tables.ListingsTable, {
  id: Schema.optionalKey(ListingId),
  productId: ProductId,
  retailerId: RetailerId,
  url: Url,
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceListingUpdate = createUpdateSchema(Tables.ListingsTable, {
  id: Schema.optionalKey(ListingId),
  productId: Schema.optionalKey(ProductId),
  retailerId: Schema.optionalKey(RetailerId),
  url: Schema.optionalKey(Url),
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceListingVariant = createSelectSchema(
  Tables.ListingVariantsTable,
  {
    listingId: ListingId,
    variantId: VariantId,
  },
)

const referencePage = createSelectSchema(Tables.PagesTable, {
  id: PageId,
  brandId: BrandId,
  retailerId: RetailerId,
  url: Url,
  lastScrapedAt: nullable(Timestamp),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

const referencePageInsert = createInsertSchema(Tables.PagesTable, {
  id: Schema.optionalKey(PageId),
  brandId: BrandId,
  retailerId: RetailerId,
  url: Url,
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referencePageUpdate = createUpdateSchema(Tables.PagesTable, {
  id: Schema.optionalKey(PageId),
  brandId: Schema.optionalKey(BrandId),
  retailerId: Schema.optionalKey(RetailerId),
  url: Schema.optionalKey(Url),
  lastScrapedAt: Schema.optionalKey(nullable(Timestamp)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceScrape = createSelectSchema(Tables.ScrapesTable, {
  id: ScrapeId,
  listingId: nullable(ListingId),
  pageId: nullable(PageId),
  rootSpanId: Execution.SpanId,
  country: nullable(Schema.String),
  requestHeaders: nullable(ScrapeEnvelope.Headers),
  startedAt: nullable(Timestamp),
  finishedAt: nullable(Timestamp),
  errorCode: nullable(ScrapeErrorCode),
  errorMessage: nullable(Schema.String),
  htmlR2Key: nullable(Schema.String),
  rawR2Key: nullable(Schema.String),
  finalUrl: nullable(Schema.String),
  statusCode: nullable(Schema.Int),
  responseHeaders: nullable(ScrapeEnvelope.Headers),
  cookies: nullable(Json),
  innerText: nullable(Schema.String),
  userAgent: nullable(Schema.String),
  ipInfo: nullable(Json),
  type: nullable(Schema.String),
  session: nullable(Schema.String),
  attempts: nullable(Schema.Int),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}).check(exactlyOneParent)

const referenceScrapeInsert = createInsertSchema(Tables.ScrapesTable, {
  id: Schema.optionalKey(ScrapeId),
  listingId: Schema.optionalKey(nullable(ListingId)),
  pageId: Schema.optionalKey(nullable(PageId)),
  rootSpanId: Execution.SpanId,
  country: Schema.optionalKey(nullable(Schema.String)),
  requestHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  errorCode: Schema.optionalKey(nullable(ScrapeErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  htmlR2Key: Schema.optionalKey(nullable(Schema.String)),
  rawR2Key: Schema.optionalKey(nullable(Schema.String)),
  finalUrl: Schema.optionalKey(nullable(Schema.String)),
  statusCode: Schema.optionalKey(nullable(Schema.Int)),
  responseHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
  cookies: Schema.optionalKey(nullable(Json)),
  innerText: Schema.optionalKey(nullable(Schema.String)),
  userAgent: Schema.optionalKey(nullable(Schema.String)),
  ipInfo: Schema.optionalKey(nullable(Json)),
  type: Schema.optionalKey(nullable(Schema.String)),
  session: Schema.optionalKey(nullable(Schema.String)),
  attempts: Schema.optionalKey(nullable(Schema.Int)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceScrapeUpdate = createUpdateSchema(Tables.ScrapesTable, {
  id: Schema.optionalKey(ScrapeId),
  listingId: Schema.optionalKey(nullable(ListingId)),
  pageId: Schema.optionalKey(nullable(PageId)),
  rootSpanId: Schema.optionalKey(Execution.SpanId),
  country: Schema.optionalKey(nullable(Schema.String)),
  requestHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  errorCode: Schema.optionalKey(nullable(ScrapeErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  htmlR2Key: Schema.optionalKey(nullable(Schema.String)),
  rawR2Key: Schema.optionalKey(nullable(Schema.String)),
  finalUrl: Schema.optionalKey(nullable(Schema.String)),
  statusCode: Schema.optionalKey(nullable(Schema.Int)),
  responseHeaders: Schema.optionalKey(nullable(ScrapeEnvelope.Headers)),
  cookies: Schema.optionalKey(nullable(Json)),
  innerText: Schema.optionalKey(nullable(Schema.String)),
  userAgent: Schema.optionalKey(nullable(Schema.String)),
  ipInfo: Schema.optionalKey(nullable(Json)),
  type: Schema.optionalKey(nullable(Schema.String)),
  session: Schema.optionalKey(nullable(Schema.String)),
  attempts: Schema.optionalKey(nullable(Schema.Int)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceExtraction = createSelectSchema(Tables.ExtractionsTable, {
  id: ExtractionId,
  scrapeId: ScrapeId,
  startedAt: nullable(Timestamp),
  finishedAt: nullable(Timestamp),
  extractedJson: nullable(Json),
  promptTokens: nullable(Schema.Int),
  completionTokens: nullable(Schema.Int),
  totalTokens: nullable(Schema.Int),
  errorCode: nullable(ExtractionErrorCode),
  errorMessage: nullable(Schema.String),
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

const referenceExtractionInsert = createInsertSchema(Tables.ExtractionsTable, {
  id: Schema.optionalKey(ExtractionId),
  scrapeId: ScrapeId,
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  extractedJson: Schema.optionalKey(nullable(Json)),
  promptTokens: Schema.optionalKey(nullable(Schema.Int)),
  completionTokens: Schema.optionalKey(nullable(Schema.Int)),
  totalTokens: Schema.optionalKey(nullable(Schema.Int)),
  errorCode: Schema.optionalKey(nullable(ExtractionErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const referenceExtractionUpdate = createUpdateSchema(Tables.ExtractionsTable, {
  id: Schema.optionalKey(ExtractionId),
  scrapeId: Schema.optionalKey(ScrapeId),
  startedAt: Schema.optionalKey(nullable(Timestamp)),
  finishedAt: Schema.optionalKey(nullable(Timestamp)),
  extractedJson: Schema.optionalKey(nullable(Json)),
  promptTokens: Schema.optionalKey(nullable(Schema.Int)),
  completionTokens: Schema.optionalKey(nullable(Schema.Int)),
  totalTokens: Schema.optionalKey(nullable(Schema.Int)),
  errorCode: Schema.optionalKey(nullable(ExtractionErrorCode)),
  errorMessage: Schema.optionalKey(nullable(Schema.String)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

const cases = [
  {
    name: "Brand",
    application: Brand.Info,
    reference: referenceBrand,
    table: Tables.BrandsTable,
    row: () => rows.brands,
  },
  {
    name: "BrandInsert",
    application: Brand.Insert,
    reference: referenceBrandInsert,
    table: Tables.BrandsTable,
    row: () => rows.brands,
  },
  {
    name: "BrandUpdate",
    application: Brand.UpdateRow,
    reference: referenceBrandUpdate,
    table: Tables.BrandsTable,
    row: () => rows.brands,
  },
  {
    name: "Product",
    application: Product.Info,
    reference: referenceProduct,
    table: Tables.ProductsTable,
    row: () => rows.products,
  },
  {
    name: "ProductInsert",
    application: Product.Insert,
    reference: referenceProductInsert,
    table: Tables.ProductsTable,
    row: () => rows.products,
  },
  {
    name: "ProductUpdate",
    application: Product.UpdateRow,
    reference: referenceProductUpdate,
    table: Tables.ProductsTable,
    row: () => rows.products,
  },
  {
    name: "Variant",
    application: ProductVariant.Info,
    reference: referenceVariant,
    table: Tables.ProductVariantsTable,
    row: () => rows.variants,
  },
  {
    name: "VariantInsert",
    application: ProductVariant.Insert,
    reference: referenceVariantInsert,
    table: Tables.ProductVariantsTable,
    row: () => rows.variants,
  },
  {
    name: "VariantUpdate",
    application: ProductVariant.UpdateRow,
    reference: referenceVariantUpdate,
    table: Tables.ProductVariantsTable,
    row: () => rows.variants,
  },
  {
    name: "Retailer",
    application: Retailer.Info,
    reference: referenceRetailer,
    table: Tables.RetailersTable,
    row: () => rows.retailers,
  },
  {
    name: "RetailerInsert",
    application: Retailer.Insert,
    reference: referenceRetailerInsert,
    table: Tables.RetailersTable,
    row: () => rows.retailers,
  },
  {
    name: "RetailerUpdate",
    application: Retailer.UpdateRow,
    reference: referenceRetailerUpdate,
    table: Tables.RetailersTable,
    row: () => rows.retailers,
  },
  {
    name: "Listing",
    application: Listing.Info,
    reference: referenceListing,
    table: Tables.ListingsTable,
    row: () => rows.listings,
  },
  {
    name: "ListingInsert",
    application: Listing.Insert,
    reference: referenceListingInsert,
    table: Tables.ListingsTable,
    row: () => rows.listings,
  },
  {
    name: "ListingUpdate",
    application: Listing.UpdateRow,
    reference: referenceListingUpdate,
    table: Tables.ListingsTable,
    row: () => rows.listings,
  },
  {
    name: "ListingVariant",
    application: Listing.Variant,
    reference: referenceListingVariant,
    table: Tables.ListingVariantsTable,
    row: () => rows.listingVariants,
  },
  {
    name: "Page",
    application: Page.Info,
    reference: referencePage,
    table: Tables.PagesTable,
    row: () => rows.pages,
  },
  {
    name: "PageInsert",
    application: Page.Insert,
    reference: referencePageInsert,
    table: Tables.PagesTable,
    row: () => rows.pages,
  },
  {
    name: "PageUpdate",
    application: Page.UpdateRow,
    reference: referencePageUpdate,
    table: Tables.PagesTable,
    row: () => rows.pages,
  },
  {
    name: "Scrape",
    application: Scrape.Info,
    reference: referenceScrape,
    table: Tables.ScrapesTable,
    row: () => rows.scrapes,
  },
  {
    name: "ScrapeInsert",
    application: Scrape.Insert,
    reference: referenceScrapeInsert,
    table: Tables.ScrapesTable,
    row: () => rows.scrapes,
  },
  {
    name: "ScrapeUpdate",
    application: Scrape.UpdateRow,
    reference: referenceScrapeUpdate,
    table: Tables.ScrapesTable,
    row: () => rows.scrapes,
  },
  {
    name: "Extraction",
    application: Extraction.Info,
    reference: referenceExtraction,
    table: Tables.ExtractionsTable,
    row: () => rows.extractions,
  },
  {
    name: "ExtractionInsert",
    application: Extraction.Insert,
    reference: referenceExtractionInsert,
    table: Tables.ExtractionsTable,
    row: () => rows.extractions,
  },
  {
    name: "ExtractionUpdate",
    application: Extraction.UpdateRow,
    reference: referenceExtractionUpdate,
    table: Tables.ExtractionsTable,
    row: () => rows.extractions,
  },
]

describe("explicit application schemas versus Drizzle", () => {
  for (const entry of cases) {
    it(`${entry.name} preserves real rows, keys, omission, undefined, null and field encodings`, () => {
      const row = entry.row()
      expect(row).toBeDefined()

      if (row === undefined) throw new Error("seed missing")
      expect(Object.keys(entry.application.fields)).toEqual(
        Object.keys(getColumns(entry.table)),
      )
      expect(
        Option.isSome(Schema.decodeUnknownOption(entry.application)(row)),
      ).toBe(true)
      compare(entry.application, entry.reference, row)
      compare(entry.application, entry.reference, {})

      for (const key of Object.keys(row)) {
        const omitted = Object.fromEntries(
          Object.entries(row).filter(([name]) => name !== key),
        )

        compare(entry.application, entry.reference, omitted)

        for (const value of values) {
          compare(entry.application, entry.reference, { ...row, [key]: value })
        }
      }
    })
  }
})
