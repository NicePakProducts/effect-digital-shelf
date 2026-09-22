import { BrandsErrors, Brands } from "@app/core/brands"
import { RetailersErrors, Retailers } from "@app/core/retailers"
import { ListingsErrors, Listings } from "@app/core/listings"
import { PagesErrors, Pages } from "@app/core/pages"
import { ScrapesErrors, Scrapes } from "@app/core/scrapes"
import { ExtractionsErrors, Extractions } from "@app/core/scrapes/extractions"
import { expect, it } from "@effect/vitest"
import { BrandNotFound } from "@app/protocol/brands"
import {
  RetailerNotFound,
  InvalidRetailerDomain,
  RetailerDomainTaken,
} from "@app/protocol/retailers"
import { ListingNotFound } from "@app/protocol/listings"
import { PageNotFound } from "@app/protocol/pages"
import { ScrapeNotFound } from "@app/protocol/scrapes"
import { ExtractionNotFound } from "@app/protocol/extractions"
import {
  BrandId,
  RetailerId,
  ListingId,
  PageId,
  ScrapeId,
  ExtractionId,
} from "@app/schema/ids"
import { Api } from "@app/protocol/api"
import * as DbTest from "@app/core/test/layers/Db"
import { Effect, Schema } from "effect"
import * as HttpApiTest from "effect/unstable/httpapi/HttpApiTest"
import * as ApiTest from "./layers/Api"

const missing = "00000000-0000-4000-8000-000000000404"

it.layer(ApiTest.TestLayer, { timeout: "60 seconds" })(
  "business failure ownership",
  (it) => {
    it.effect(
      "real repositories return core errors; all remaining handlers construct independent protocol errors and exact 404 bodies",
      () =>
        Effect.gen(function* () {
          yield* DbTest.reset
          const brands = yield* Brands.Service
          const retailers = yield* Retailers.Service
          const listings = yield* Listings.Service
          const pages = yield* Pages.Service
          const scrapes = yield* Scrapes.Service
          const extractions = yield* Extractions.Service

          const api = yield* HttpApiTest.groups(Api, [
            "brands",
            "retailers",
            "listings",
            "pages",
            "scrapes",
            "extractions",
          ])

          const brandId = Schema.decodeUnknownSync(BrandId)(missing)
          const retailerId = Schema.decodeUnknownSync(RetailerId)(missing)
          const listingId = Schema.decodeUnknownSync(ListingId)(missing)
          const pageId = Schema.decodeUnknownSync(PageId)(missing)
          const scrapeId = Schema.decodeUnknownSync(ScrapeId)(missing)
          const extractionId = Schema.decodeUnknownSync(ExtractionId)(missing)

          const cases = [
            {
              path: "brands",
              field: "brandId",
              tag: "BrandNotFound",
              coreType: BrandsErrors.NotFound,
              protocolType: BrandNotFound,
              coreError: yield* brands.get({ brandId }).pipe(Effect.flip),
              httpError: yield* api.brands
                .get({ params: { id: brandId } })
                .pipe(Effect.flip),
            },
            {
              path: "retailers",
              field: "retailerId",
              tag: "RetailerNotFound",
              coreType: RetailersErrors.NotFound,
              protocolType: RetailerNotFound,
              coreError: yield* retailers.get({ retailerId }).pipe(Effect.flip),
              httpError: yield* api.retailers
                .get({ params: { id: retailerId } })
                .pipe(Effect.flip),
            },
            {
              path: "listings",
              field: "listingId",
              tag: "ListingNotFound",
              coreType: ListingsErrors.NotFound,
              protocolType: ListingNotFound,
              coreError: yield* listings.get({ listingId }).pipe(Effect.flip),
              httpError: yield* api.listings
                .get({ params: { id: listingId } })
                .pipe(Effect.flip),
            },
            {
              path: "pages",
              field: "pageId",
              tag: "PageNotFound",
              coreType: PagesErrors.NotFound,
              protocolType: PageNotFound,
              coreError: yield* pages.get({ pageId }).pipe(Effect.flip),
              httpError: yield* api.pages
                .get({ params: { id: pageId } })
                .pipe(Effect.flip),
            },
            {
              path: "scrapes",
              field: "scrapeId",
              tag: "ScrapeNotFound",
              coreType: ScrapesErrors.NotFound,
              protocolType: ScrapeNotFound,
              coreError: yield* scrapes.get({ scrapeId }).pipe(Effect.flip),
              httpError: yield* api.scrapes
                .get({ params: { id: scrapeId } })
                .pipe(Effect.flip),
            },
            {
              path: "extractions",
              field: "extractionId",
              tag: "ExtractionNotFound",
              coreType: ExtractionsErrors.NotFound,
              protocolType: ExtractionNotFound,
              coreError: yield* extractions
                .get({ extractionId })
                .pipe(Effect.flip),
              httpError: yield* api.extractions
                .get({ params: { id: extractionId } })
                .pipe(Effect.flip),
            },
          ]

          const raw = yield* ApiTest.rawClient

          for (const entry of cases) {
            expect(entry.coreError).toBeInstanceOf(entry.coreType)
            expect(entry.coreError).not.toBeInstanceOf(entry.protocolType)
            expect(entry.httpError).toBeInstanceOf(entry.protocolType)
            expect(entry.httpError).not.toBeInstanceOf(entry.coreType)

            const response = yield* raw.get(
              `${ApiTest.baseUrl}/${entry.path}/${missing}`,
            )

            const body = Schema.decodeUnknownSync(Schema.JsonObject)(
              yield* response.json,
            )

            expect(response.status).toBe(404)
            expect(Object.keys(body).sort()).toEqual(
              ["_tag", entry.field].sort(),
            )
            expect(body["_tag"]).toBe(entry.tag)
            expect(body[entry.field]).toBe(missing)
          }
        }),
    )

    it.effect(
      "Retailer validation and uniqueness retain distinct core/protocol identities and 422/409 wire fields",
      () =>
        Effect.gen(function* () {
          yield* DbTest.reset
          const retailers = yield* Retailers.Service
          const api = yield* HttpApiTest.groups(Api, ["retailers"])
          const invalid = { name: "Invalid", domain: "localhost" }
          const invalidCore = yield* retailers.create(invalid).pipe(Effect.flip)

          const invalidHttp = yield* api.retailers
            .create({ payload: invalid })
            .pipe(Effect.flip)

          const invalidResponse = yield* api.retailers.create({
            payload: invalid,
            responseMode: "response-only",
          })

          const invalidBody = Schema.decodeUnknownSync(Schema.JsonObject)(
            yield* invalidResponse.json,
          )

          expect(invalidCore).toBeInstanceOf(RetailersErrors.InvalidDomain)
          expect(invalidHttp).toBeInstanceOf(InvalidRetailerDomain)
          expect(invalidHttp).not.toBeInstanceOf(RetailersErrors.InvalidDomain)
          expect(invalidResponse.status).toBe(422)
          expect(Object.keys(invalidBody).sort()).toEqual(["_tag", "input"])
          expect(invalidBody["_tag"]).toBe("InvalidRetailerDomain")
          expect(invalidBody["input"]).toBe("localhost")

          const existing = yield* retailers.create({
            name: "Existing",
            domain: "example.test",
          })

          const duplicate = {
            name: "Duplicate",
            domain: "https://WWW.EXAMPLE.TEST/path",
          }

          const duplicateCore = yield* retailers
            .create(duplicate)
            .pipe(Effect.flip)

          const duplicateHttp = yield* api.retailers
            .create({ payload: duplicate })
            .pipe(Effect.flip)

          const duplicateResponse = yield* api.retailers.create({
            payload: duplicate,
            responseMode: "response-only",
          })

          const duplicateBody = Schema.decodeUnknownSync(Schema.JsonObject)(
            yield* duplicateResponse.json,
          )

          expect(duplicateCore).toBeInstanceOf(RetailersErrors.DomainTaken)
          expect(duplicateHttp).toBeInstanceOf(RetailerDomainTaken)
          expect(duplicateHttp).not.toBeInstanceOf(RetailersErrors.DomainTaken)
          expect(duplicateResponse.status).toBe(409)
          expect(Object.keys(duplicateBody).sort()).toEqual([
            "_tag",
            "domain",
            "retailerId",
          ])
          expect(duplicateBody["_tag"]).toBe("RetailerDomainTaken")
          expect(duplicateBody["domain"]).toBe("example.test")
          expect(duplicateBody["retailerId"]).toBe(existing.id)
          expect(yield* retailers.list).toHaveLength(1)
        }),
    )
  },
)
