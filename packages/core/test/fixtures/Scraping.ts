import { LanguageModelTest } from "../layers/LanguageModel"
import { ExtractionsRepo } from "../../src/scrapes/extractions/repository"
import { htmlKey } from "@app/core/scrapes/r2-keys"
import {
  ScrapeId,
  BrandId,
  ProductId,
  RetailerId,
  ListingId,
  PageId,
} from "@app/schema/ids"
import type {
  ExtractionStatus,
  ScrapeMode,
  ScrapeStatus,
} from "@app/schema/scraping-vocabulary"
import type { Cadence } from "@app/schema/cadence"
import { BrandsTable } from "@app/db/schema/brands"
import { RetailersTable } from "@app/db/schema/retailers"
import { ProductsTable } from "@app/db/schema/products"
import { ListingsTable } from "@app/db/schema/listings"
import { PagesTable } from "@app/db/schema/pages"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { ScrapesRepo } from "../../src/scrapes/repository"
import { Scrape } from "@app/schema/scrape"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as DbTest from "../layers/Db"
import { ExecutionsTest } from "../layers/Executions"
import { ScrapeProvidersTest } from "../layers/ScrapeProviders"
import { R2BucketTest } from "../layers/R2Bucket"

export const reset = Effect.gen(function* () {
  const languageModelTest = yield* LanguageModelTest
  yield* languageModelTest.reset
  yield* DbTest.reset
  const executionsTest = yield* ExecutionsTest
  yield* executionsTest.reset
  const scrapeProvidersTest = yield* ScrapeProvidersTest
  yield* scrapeProvidersTest.reset
  const bucketTest = yield* R2BucketTest
  yield* bucketTest.reset
})

export const seed = Effect.fn("fixture.seed")(function* (
  options: {
    paused?: boolean
    cadence?: Cadence
    mode?: ScrapeMode
    country?: string
  } = {},
) {
  const db = yield* Db
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const brandId = Schema.decodeUnknownSync(BrandId)(crypto.randomUUID())
  const retailerId = Schema.decodeUnknownSync(RetailerId)(crypto.randomUUID())
  const productId = Schema.decodeUnknownSync(ProductId)(crypto.randomUUID())
  yield* query(
    db
      .insert(BrandsTable)
      .values({ id: brandId, name: "Gaia", createdAt: now, updatedAt: now }),
  )
  yield* query(
    db.insert(RetailersTable).values({
      id: retailerId,
      name: "Retailer",
      domain: `${retailerId}.example.com`,
      scrapeMode: options.mode ?? "basic",
      scrapeCountry: options.country ?? "Australia",
      listingExtractPrompt: "Extract listing",
      pageExtractPrompt: "Extract page",
      createdAt: now,
      updatedAt: now,
    }),
  )
  yield* query(
    db.insert(ProductsTable).values({
      id: productId,
      brandId,
      name: "Product",
      paused: options.paused ?? false,
      createdAt: now,
      updatedAt: now,
    }),
  )

  const listing = Effect.gen(function* () {
    const now = DateTime.toDateUtc(yield* DateTime.now)
    const listingId = Schema.decodeUnknownSync(ListingId)(crypto.randomUUID())
    const url = `https://${retailerId}.example.com/${listingId}`
    yield* query(
      db.insert(ListingsTable).values({
        id: listingId,
        productId,
        retailerId,
        url,
        cadence: options.cadence ?? "daily",
        createdAt: now,
        updatedAt: now,
      }),
    )

    return {
      parent: Scrape.Parent.members[0].make({
        listingId,
      }) satisfies Scrape.Parent,
      url,
    }
  })

  const page = Effect.gen(function* () {
    const pageId = Schema.decodeUnknownSync(PageId)(crypto.randomUUID())
    const url = `https://${retailerId}.example.com/brand`
    yield* query(
      db.insert(PagesTable).values({
        id: pageId,
        brandId,
        retailerId,
        url,
        cadence: options.cadence ?? "daily",
        paused: options.paused ?? false,
        createdAt: now,
        updatedAt: now,
      }),
    )

    return {
      parent: Scrape.Parent.members[1].make({ pageId }) satisfies Scrape.Parent,
      url,
    }
  })

  return { brandId, productId, retailerId, listing, page }
})

export const history = Effect.fn("fixture.history")(
  function* (
    parent: Scrape.Parent,
    status: ScrapeStatus,
    age: Duration.Input,
    startedAge?: Duration.Input,
  ) {
    const scrapesRepo = yield* ScrapesRepo.Service

    const now = yield* DateTime.now

    const createdAt = DateTime.subtractDuration(
      now,
      Duration.fromInputUnsafe(age),
    )

    return Option.getOrThrow(
      yield* scrapesRepo.insertUnlessInFlight({
        ...Scrape.parentColumns(parent),
        status,
        requestUrl: "https://example.com/snapshot",
        mode: "basic",
        rootSpanId: "0123456789abcdef",
        createdAt,
        updatedAt: createdAt,
        startedAt:
          startedAge === undefined
            ? Option.none()
            : Option.some(
                DateTime.subtractDuration(
                  now,
                  Duration.fromInputUnsafe(startedAge),
                ),
              ),
      }),
    )
  },
  Effect.provide([ScrapesRepo.layer]),
)

export const cadenceFixture = Effect.gen(function* () {
  const catalog = yield* seed()
  const duePage = yield* catalog.page
  const pausedPageCatalog = yield* seed({ paused: true })
  const pausedPage = yield* pausedPageCatalog.page
  const never = yield* catalog.listing
  const recentSuccess = yield* catalog.listing
  yield* history(recentSuccess.parent, "success", "2 hours")
  const oldFailure = yield* catalog.listing
  yield* history(oldFailure.parent, "failed", "25 hours")
  const recentFailure = yield* catalog.listing
  yield* history(recentFailure.parent, "failed", "1 hour")
  const inFlight = yield* catalog.listing
  yield* history(inFlight.parent, "running", "2 hours", "1 minute")
  const pausedListingCatalog = yield* seed({ paused: true })
  const paused = yield* pausedListingCatalog.listing

  return {
    catalog,
    duePage,
    pausedPage,
    never,
    recentSuccess,
    oldFailure,
    recentFailure,
    inFlight,
    paused,
  }
})

export const successfulScrape = Effect.fn("fixture.successfulScrape")(
  function* (
    parent: Scrape.Parent,
    options: { age?: Duration.Input; html?: string } = {},
  ) {
    const scrapesRepo = yield* ScrapesRepo.Service

    const now = yield* DateTime.now
    const at = DateTime.subtractDuration(now, options.age ?? "0 seconds")
    const id = Schema.decodeUnknownSync(ScrapeId)(crypto.randomUUID())
    const key = htmlKey(id)

    const row = yield* scrapesRepo.insert({
      id,
      ...Scrape.parentColumns(parent),
      status: "success",
      requestUrl: "https://example.com/snapshot",
      mode: "basic",
      rootSpanId: "0123456789abcdef",
      htmlR2Key: Option.some(key),
      finishedAt: Option.some(at),
      createdAt: at,
      updatedAt: at,
    })

    const bucketTest = yield* R2BucketTest
    yield* bucketTest.service.put(
      key,
      options.html ?? "<p>Hello</p>",
      "text/html",
    )

    return row
  },
  Effect.provide([ScrapesRepo.layer]),
)

export const extraction = Effect.fn("fixture.extraction")(
  function* (
    scrapeId: ScrapeId,
    attempt: number,
    status: ExtractionStatus,
    options: { prompt?: string; model?: string; age?: Duration.Input } = {},
  ) {
    const scrapesRepo = yield* ScrapesRepo.Service
    const extractionsRepo = yield* ExtractionsRepo.Service

    const at = DateTime.subtractDuration(
      yield* DateTime.now,
      options.age ?? "0 seconds",
    )

    const scrape = yield* scrapesRepo.get(scrapeId)

    return yield* extractionsRepo.insert({
      scrapeId,
      attempt,
      status,
      promptKind: Option.isSome(scrape.listingId) ? "listing" : "page",
      promptSnapshot: options.prompt ?? "Extract listing",
      model: options.model ?? "@cf/zai-org/glm-4.7-flash",
      createdAt: at,
      updatedAt: at,
      startedAt: status === "pending" ? Option.none() : Option.some(at),
      finishedAt:
        status === "success" || status === "failed"
          ? Option.some(at)
          : Option.none(),
      extractedJson:
        status === "success" ? Option.some({ attempt }) : Option.none(),
    })
  },
  Effect.provide([ScrapesRepo.layer, ExtractionsRepo.layer]),
)
