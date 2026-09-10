import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import { keysOf } from "@digital-shelf/core/Scraping/R2Keys"
import { emptyImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import { scrapes, extractions } from "@digital-shelf/domain/Sql/Scraping"
import { R2BucketTest } from "../layers/R2Bucket.ts"
import { expect, it } from "@effect/vitest"
import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { Products } from "@digital-shelf/core/Catalog/Products"
import { Retailers } from "@digital-shelf/core/Catalog/Retailers"
import { Pages } from "@digital-shelf/core/Catalog/Pages"
import {
  BrandNotFound,
  RetailerNotFound,
  PageNotFound,
  PageAlreadyExists,
} from "@digital-shelf/domain/Catalog/Errors"
import { BrandId, RetailerId, PageId } from "@digital-shelf/domain/Shared/Ids"
import { Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core.ts"
import * as DbTest from "../layers/Db.ts"
import { seed } from "../fixtures/Catalog.ts"
import { history, extraction } from "../fixtures/Scraping.ts"
it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("Pages", (it) => {
  it.effect(
    "removes two descendant Scrapes, their Extractions and R2 objects",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const service = yield* Pages
        const row = yield* service.create({
          brandId: c.brandId,
          retailerId: c.retailerId,
          url: "https://example.com/remove",
        })
        const bucket = yield* R2BucketTest
        yield* bucket.reset
        for (const age of ["2 hours", "1 hour"] as const) {
          const scrape = yield* history(
            { _tag: "Page", pageId: row.id },
            "success",
            age,
          )
          yield* extraction(scrape.id, 1, "success")
          for (const key of keysOf(scrape.id))
            yield* bucket.service.put(key, "payload", "text/plain")
        }
        const db = yield* Db
        expect(yield* query(db.select().from(scrapes))).toHaveLength(2)
        expect(yield* query(db.select().from(extractions))).toHaveLength(2)
        expect((yield* bucket.inspect).size).toBe(4)
        expect(yield* service.remove(row.id)).toEqual({
          ...emptyImpact,
          scrapes: 2,
        })
        expect(yield* query(db.select().from(scrapes))).toEqual([])
        expect(yield* query(db.select().from(extractions))).toEqual([])
        expect((yield* bucket.inspect).size).toBe(0)
      }),
  )
  it.effect(
    "is unique per Brand and Retailer and returns the existing Page id",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const pages = yield* Pages
        const command = {
          brandId: c.brandId,
          retailerId: c.retailerId,
          url: "https://example.com/brand",
        }
        const page = yield* pages.create(command)
        expect(page.cadence).toBe("monthly")
        expect(page.paused).toBe(false)
        expect(yield* Effect.flip(pages.create(command))).toEqual(
          new PageAlreadyExists({
            brandId: c.brandId,
            retailerId: c.retailerId,
            pageId: page.id,
          }),
        )
        expect(yield* pages.get(page.id)).toEqual(page)
      }),
  )
  for (const source of ["Brand", "Retailer", "Page", "Product"] as const) {
    it.effect(
      `reads effective pause from ${source}${source === "Product" ? " as false" : " as true"}`,
      () =>
        Effect.gen(function* () {
          yield* DbTest.reset
          const c = yield* seed()
          const pages = yield* Pages
          const page = yield* pages.create({
            brandId: c.brandId,
            retailerId: c.retailerId,
            url: "https://example.com/brand",
          })
          if (source === "Brand")
            yield* (yield* Brands).update(c.brandId, { paused: true })
          if (source === "Retailer")
            yield* (yield* Retailers).update(c.retailerId, { paused: true })
          if (source === "Product")
            yield* (yield* Products).update(c.productId, { paused: true })
          if (source === "Page") yield* pages.update(page.id, { paused: true })
          expect((yield* pages.get(page.id)).effectivePaused).toBe(
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
        const pages = yield* Pages
        const page = yield* pages.create({
          brandId: c.brandId,
          retailerId: c.retailerId,
          url: "https://example.com/brand",
        })
        expect(page.combinedStatus).toBe("none")
        yield* history({ _tag: "Page", pageId: page.id }, "running", "1 minute")
        expect((yield* pages.get(page.id)).combinedStatus).toBe("running")
        expect((yield* pages.list())[0]?.combinedStatus).toBe("running")
      }),
  )
  it.effect("filters by Brand, Retailer and their intersection", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const a = yield* seed()
      const b = yield* seed()
      const pages = yield* Pages
      const first = yield* pages.create({
        brandId: a.brandId,
        retailerId: a.retailerId,
        url: "https://example.com/a",
      })
      const second = yield* pages.create({
        brandId: a.brandId,
        retailerId: b.retailerId,
        url: "https://example.com/b",
      })
      yield* pages.create({
        brandId: b.brandId,
        retailerId: b.retailerId,
        url: "https://example.com/c",
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
      const pages = yield* Pages
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
            url: "https://example.com",
          }),
        ),
      ).toEqual(new BrandNotFound({ brandId }))
      expect(
        yield* Effect.flip(
          pages.create({
            brandId: c.brandId,
            retailerId,
            url: "https://example.com",
          }),
        ),
      ).toEqual(new RetailerNotFound({ retailerId }))
      const error = new PageNotFound({ pageId: id })
      expect(yield* Effect.flip(pages.get(id))).toEqual(error)
      expect(yield* Effect.flip(pages.update(id, {}))).toEqual(error)
      expect(yield* Effect.flip(pages.impact(id))).toEqual(error)
      expect(yield* Effect.flip(pages.remove(id))).toEqual(error)
    }),
  )
})
