import { LanguageModelTest } from "../layers/LanguageModel.ts"
import * as ExtractionsRepo from "@digital-shelf/core/Scraping/repositories/ExtractionsRepo"
import { htmlKey } from "@digital-shelf/core/Scraping/R2Keys"
import { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import type { ExtractionStatus } from "@digital-shelf/domain/Scraping/Vocabulary"
import type { Cadence } from "@digital-shelf/domain/Catalog/Cadence"
import type {
  ScrapeMode,
  ScrapeStatus,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import {
  BrandId,
  ProductId,
  RetailerId,
  ListingId,
  PageId,
} from "@digital-shelf/domain/Shared/Ids"
import {
  brands,
  retailers,
  products,
  listings,
  pages,
} from "@digital-shelf/domain/Sql/Catalog"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import * as ScrapesRepo from "@digital-shelf/core/Scraping/repositories/ScrapesRepo"
import {
  parentColumns,
  ScrapeParent,
} from "@digital-shelf/domain/Scraping/Scrape"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as DbTest from "../layers/Db.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import { ScrapeProvidersTest } from "../layers/ScrapeProviders.ts"
import { R2BucketTest } from "../layers/R2Bucket.ts"

export const reset = Effect.gen(function* () {
  yield* (yield* LanguageModelTest).reset
  yield* DbTest.reset
  yield* (yield* ExecutionsTest).reset
  yield* (yield* ScrapeProvidersTest).reset
  yield* (yield* R2BucketTest).reset
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
      .insert(brands)
      .values({ id: brandId, name: "Gaia", createdAt: now, updatedAt: now }),
  )
  yield* query(
    db.insert(retailers).values({
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
    db.insert(products).values({
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
      db.insert(listings).values({
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
      parent: ScrapeParent.members[0].make({
        listingId,
      }) satisfies ScrapeParent,
      url,
    }
  })

  const page = Effect.gen(function* () {
    const pageId = Schema.decodeUnknownSync(PageId)(crypto.randomUUID())
    const url = `https://${retailerId}.example.com/brand`
    yield* query(
      db.insert(pages).values({
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
      parent: ScrapeParent.members[1].make({ pageId }) satisfies ScrapeParent,
      url,
    }
  })

  return { brandId, productId, retailerId, listing, page }
})

export const history = Effect.fn("fixture.history")(function* (
  parent: ScrapeParent,
  status: ScrapeStatus,
  age: Duration.Input,
  startedAge?: Duration.Input,
) {
  const now = yield* DateTime.now

  const createdAt = DateTime.subtractDuration(
    now,
    Duration.fromInputUnsafe(age),
  )

  return Option.getOrThrow(
    yield* ScrapesRepo.insertUnlessInFlight({
      ...parentColumns(parent),
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
})

export const cadenceFixture = Effect.gen(function* () {
  const catalog = yield* seed()
  const duePage = yield* catalog.page
  const pausedPage = yield* (yield* seed({ paused: true })).page
  const never = yield* catalog.listing
  const recentSuccess = yield* catalog.listing
  yield* history(recentSuccess.parent, "success", "2 hours")
  const oldFailure = yield* catalog.listing
  yield* history(oldFailure.parent, "failed", "25 hours")
  const recentFailure = yield* catalog.listing
  yield* history(recentFailure.parent, "failed", "1 hour")
  const inFlight = yield* catalog.listing
  yield* history(inFlight.parent, "running", "2 hours", "1 minute")
  const paused = yield* (yield* seed({ paused: true })).listing

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
    parent: ScrapeParent,
    options: { age?: Duration.Input; html?: string } = {},
  ) {
    const now = yield* DateTime.now
    const at = DateTime.subtractDuration(now, options.age ?? "0 seconds")
    const id = Schema.decodeUnknownSync(ScrapeId)(crypto.randomUUID())
    const key = htmlKey(id)

    const row = yield* ScrapesRepo.insert({
      id,
      ...parentColumns(parent),
      status: "success",
      requestUrl: "https://example.com/snapshot",
      mode: "basic",
      rootSpanId: "0123456789abcdef",
      htmlR2Key: Option.some(key),
      finishedAt: Option.some(at),
      createdAt: at,
      updatedAt: at,
    })

    yield* (yield* R2BucketTest).service.put(
      key,
      options.html ?? "<p>Hello</p>",
      "text/html",
    )

    return row
  },
)

export const extraction = Effect.fn("fixture.extraction")(function* (
  scrapeId: ScrapeId,
  attempt: number,
  status: ExtractionStatus,
  options: { prompt?: string; model?: string; age?: Duration.Input } = {},
) {
  const at = DateTime.subtractDuration(
    yield* DateTime.now,
    options.age ?? "0 seconds",
  )

  const scrape = yield* ScrapesRepo.get(scrapeId)

  return yield* ExtractionsRepo.insert({
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
})
