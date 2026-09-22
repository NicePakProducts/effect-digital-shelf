import { BrandsErrors, Brands } from "@app/core/brands"
import { RetailersErrors, Retailers } from "@app/core/retailers"
import { PagesErrors, Pages } from "@app/core/pages"
import { Scrape } from "@app/schema/scrape"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { keysOf } from "@app/core/scrapes/r2-keys"
import { emptyImpact } from "@app/schema/cascade"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { ExtractionsTable } from "@app/db/schema/extractions"
import { R2BucketTest } from "../layers/R2Bucket"
import { expect, it } from "@effect/vitest"
import { Products } from "@app/core/products"
import { BrandId, RetailerId, PageId } from "@app/schema/ids"
import { Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"
import { seed } from "../fixtures/Catalog"
import { history, extraction } from "../fixtures/Scraping"

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Pages", (it) => {
  it.effect(
    "removes two descendant Scrapes, their Extractions and R2 objects",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const service = yield* Pages.Service

        const row = yield* service.create({
          brandId: c.brandId,
          retailerId: c.retailerId,
          url: c.url("/remove"),
        })

        const bucket = yield* R2BucketTest
        yield* bucket.reset

        for (const age of ["2 hours", "1 hour"] as const) {
          const scrape = yield* history(
            Scrape.Parent.members[1].make({ pageId: row.id }),
            "success",
            age,
          )

          yield* extraction(scrape.id, 1, "success")

          for (const key of keysOf(scrape.id))
            yield* bucket.service.put(key, "payload", "text/plain")
        }

        const db = yield* Db
        expect(yield* query(db.select().from(ScrapesTable))).toHaveLength(2)
        expect(yield* query(db.select().from(ExtractionsTable))).toHaveLength(2)
        expect((yield* bucket.inspect).size).toBe(4)
        expect(yield* service.remove({ pageId: row.id })).toEqual({
          ...emptyImpact,
          scrapes: 2,
        })
        expect(yield* query(db.select().from(ScrapesTable))).toEqual([])
        expect(yield* query(db.select().from(ExtractionsTable))).toEqual([])
        expect((yield* bucket.inspect).size).toBe(0)
      }),
  )
  it.effect(
    "is unique per Brand and Retailer and returns the existing Page id",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const pages = yield* Pages.Service

        const command = {
          brandId: c.brandId,
          retailerId: c.retailerId,
          url: c.url("/brand"),
        }

        const page = yield* pages.create(command)
        expect(page.cadence).toBe("monthly")
        expect(page.paused).toBe(false)
        expect(yield* Effect.flip(pages.create(command))).toEqual(
          new PagesErrors.AlreadyExists({
            brandId: c.brandId,
            retailerId: c.retailerId,
            pageId: page.id,
          }),
        )
        expect(yield* pages.get({ pageId: page.id })).toEqual(page)
      }),
  )

  for (const source of ["Brand", "Retailer", "Page", "Product"] as const) {
    it.effect(
      `reads effective pause from ${source}${source === "Product" ? " as false" : " as true"}`,
      () =>
        Effect.gen(function* () {
          yield* DbTest.reset
          const c = yield* seed()
          const pages = yield* Pages.Service

          const page = yield* pages.create({
            brandId: c.brandId,
            retailerId: c.retailerId,
            url: c.url("/brand"),
          })

          if (source === "Brand") {
            const brands = yield* Brands.Service
            yield* brands.update({
              brandId: c.brandId,
              command: { paused: true },
            })
          }

          if (source === "Retailer") {
            const retailers = yield* Retailers.Service
            yield* retailers.update({
              retailerId: c.retailerId,
              command: { paused: true },
            })
          }

          if (source === "Product") {
            const products = yield* Products.Service
            yield* products.update({
              productId: c.productId,
              command: { paused: true },
            })
          }

          if (source === "Page")
            yield* pages.update({ pageId: page.id, command: { paused: true } })
          expect((yield* pages.get({ pageId: page.id })).effectivePaused).toBe(
            source !== "Product",
          )
        }),
    )
  }

  it.effect(
    "reads none without a Scrape and running with a running Scrape",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const pages = yield* Pages.Service

        const page = yield* pages.create({
          brandId: c.brandId,
          retailerId: c.retailerId,
          url: c.url("/brand"),
        })

        expect(page.combinedStatus).toBe("none")
        yield* history(
          Scrape.Parent.members[1].make({ pageId: page.id }),
          "running",
          "1 minute",
        )
        expect((yield* pages.get({ pageId: page.id })).combinedStatus).toBe(
          "running",
        )
        expect((yield* pages.list())[0]?.combinedStatus).toBe("running")
      }),
  )
  it.effect("filters by Brand, Retailer and their intersection", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const a = yield* seed()
      const b = yield* seed()
      const pages = yield* Pages.Service

      const first = yield* pages.create({
        brandId: a.brandId,
        retailerId: a.retailerId,
        url: a.url("/a"),
      })

      const second = yield* pages.create({
        brandId: a.brandId,
        retailerId: b.retailerId,
        url: b.url("/b"),
      })

      yield* pages.create({
        brandId: b.brandId,
        retailerId: b.retailerId,
        url: b.url("/c"),
      })
      expect(
        new Set(
          (yield* pages.list({ brandId: a.brandId })).map((row) => row.id),
        ),
      ).toEqual(new Set([first.id, second.id]))
      expect(
        (yield* pages.list({ retailerId: a.retailerId })).map((row) => row.id),
      ).toEqual([first.id])
      expect(
        (yield* pages.list({
          brandId: a.brandId,
          retailerId: b.retailerId,
        })).map((row) => row.id),
      ).toEqual([second.id])
    }),
  )
  it.effect("returns the specific missing parent or Page id", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* seed()
      const pages = yield* Pages.Service

      const brandId = Schema.decodeUnknownSync(BrandId)(
        "00000000-0000-4000-8000-000000000404",
      )

      const retailerId = Schema.decodeUnknownSync(RetailerId)(brandId)
      const id = Schema.decodeUnknownSync(PageId)(brandId)
      expect(
        yield* Effect.flip(
          pages.create({
            brandId,
            retailerId: c.retailerId,
            url: c.url(""),
          }),
        ),
      ).toEqual(new BrandsErrors.NotFound({ brandId }))
      expect(
        yield* Effect.flip(
          pages.create({
            brandId: c.brandId,
            retailerId,
            url: c.url(""),
          }),
        ),
      ).toEqual(new RetailersErrors.NotFound({ retailerId }))
      const error = new PagesErrors.NotFound({ pageId: id })
      expect(yield* Effect.flip(pages.get({ pageId: id }))).toEqual(error)
      expect(
        yield* Effect.flip(pages.update({ pageId: id, command: {} })),
      ).toEqual(error)
      expect(yield* Effect.flip(pages.impact({ pageId: id }))).toEqual(error)
      expect(yield* Effect.flip(pages.remove({ pageId: id }))).toEqual(error)
    }),
  )
})
