import { RetailersErrors, Retailers } from "@app/core/retailers"
import { ListingsErrors, Listings } from "@app/core/listings"
import { ProductsErrors, Products } from "@app/core/products"
import { Scrape } from "@app/schema/scrape"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { keysOf } from "@app/core/scrapes/r2-keys"
import { emptyImpact } from "@app/schema/cascade"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { ExtractionsTable } from "@app/db/schema/extractions"
import { R2BucketTest } from "../layers/R2Bucket"
import { expect, it } from "@effect/vitest"
import { Brands } from "@app/core/brands"
import { ProductVariants } from "@app/core/products/variants"
import { ProductId, RetailerId, VariantId, ListingId } from "@app/schema/ids"
import { Effect, Schema } from "effect"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"
import { seed } from "../fixtures/Catalog"
import { history, extraction } from "../fixtures/Scraping"

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Listings", (it) => {
  it.effect("uses attempt 2 when Extraction timestamps tie", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* seed()
      const service = yield* Listings.Service

      const row = yield* service.create({
        productId: c.productId,
        retailerId: c.retailerId,
        url: c.url("/tie"),
      })

      const scrape = yield* history(
        Scrape.Parent.members[0].make({ listingId: row.id }),
        "success",
        "1 hour",
      )

      const first = yield* extraction(scrape.id, 1, "success")
      const second = yield* extraction(scrape.id, 2, "pending")
      const db = yield* Db
      // Force identical timestamps and make attempt 1's id sort last, so the old ordering fails deterministically.
      yield* query(
        db
          .update(ExtractionsTable)
          .set({
            createdAt: DateTime.toDateUtc(first.createdAt),
            id: "00000000-0000-4000-8000-000000000001",
          })
          .where(eq(ExtractionsTable.id, second.id)),
      )
      expect((yield* service.get({ listingId: row.id })).combinedStatus).toBe(
        "pending",
      )
      expect((yield* service.list())[0]?.combinedStatus).toBe("pending")
    }),
  )
  it.effect(
    "removes two descendant Scrapes, their Extractions and R2 objects",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const service = yield* Listings.Service

        const row = yield* service.create({
          productId: c.productId,
          retailerId: c.retailerId,
          url: c.url("/remove"),
        })

        const bucket = yield* R2BucketTest
        yield* bucket.reset

        for (const age of ["2 hours", "1 hour"] as const) {
          const scrape = yield* history(
            Scrape.Parent.members[0].make({ listingId: row.id }),
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
        expect(yield* service.remove({ listingId: row.id })).toEqual({
          ...emptyImpact,
          scrapes: 2,
        })
        expect(yield* query(db.select().from(ScrapesTable))).toEqual([])
        expect(yield* query(db.select().from(ExtractionsTable))).toEqual([])
        expect((yield* bucket.inspect).size).toBe(0)
      }),
  )
  it.effect(
    "returns coverage in Variant name order, deduplicated, unpaused and with no Scrape",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const variants = yield* ProductVariants.Service
        const b = yield* variants.create({ productId: c.productId, name: "B" })
        const a = yield* variants.create({ productId: c.productId, name: "A" })
        const listings = yield* Listings.Service

        const row = yield* listings.create({
          productId: c.productId,
          retailerId: c.retailerId,
          url: c.url("/item"),
          variantIds: [b.id, a.id, b.id],
        })

        expect(row.variantIds).toEqual([a.id, b.id])
        expect(row.effectivePaused).toBe(false)
        expect(row.combinedStatus).toBe("none")
        expect(row.cadence).toBe("monthly")
        expect(yield* listings.get({ listingId: row.id })).toEqual(row)
      }),
  )
  it.effect(
    "rejects coverage outside the Product, including nonexistent ids, and rolls back updates",
    () =>
      Effect.gen(function* () {
        const variants = yield* ProductVariants.Service
        yield* DbTest.reset
        const a = yield* seed()
        const b = yield* seed()

        const variant = yield* variants.create({
          productId: b.productId,
          name: "Other",
        })

        const listings = yield* Listings.Service

        const command = {
          productId: a.productId,
          retailerId: a.retailerId,
          url: a.url("/item"),
        }

        for (const variantId of [
          variant.id,
          Schema.decodeUnknownSync(VariantId)(
            "00000000-0000-4000-8000-000000000404",
          ),
        ]) {
          expect(
            yield* Effect.flip(
              listings.create({ ...command, variantIds: [variantId] }),
            ),
          ).toEqual(
            new ListingsErrors.VariantNotInProduct({
              productId: a.productId,
              variantId,
            }),
          )
        }

        expect(yield* listings.list()).toEqual([])
        const row = yield* listings.create(command)
        expect(
          yield* Effect.flip(
            listings.update({
              listingId: row.id,
              command: {
                url: a.url("/new"),
                variantIds: [variant.id],
              },
            }),
          ),
        ).toEqual(
          new ListingsErrors.VariantNotInProduct({
            productId: a.productId,
            variantId: variant.id,
          }),
        )
        expect(yield* listings.get({ listingId: row.id })).toEqual(row)
      }),
  )
  it.effect("returns missing Product and Retailer errors with their ids", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* seed()
      const listings = yield* Listings.Service

      const productId = Schema.decodeUnknownSync(ProductId)(
        "00000000-0000-4000-8000-000000000404",
      )

      const retailerId = Schema.decodeUnknownSync(RetailerId)(productId)
      expect(
        yield* Effect.flip(
          listings.create({
            productId,
            retailerId: c.retailerId,
            url: c.url(""),
          }),
        ),
      ).toEqual(new ProductsErrors.NotFound({ productId }))
      expect(
        yield* Effect.flip(
          listings.create({
            productId: c.productId,
            retailerId,
            url: c.url(""),
          }),
        ),
      ).toEqual(new RetailersErrors.NotFound({ retailerId }))
    }),
  )
  it.effect("keeps omitted coverage and clears an explicit empty set", () =>
    Effect.gen(function* () {
      const variants = yield* ProductVariants.Service
      yield* DbTest.reset
      const c = yield* seed()

      const variant = yield* variants.create({
        productId: c.productId,
        name: "A",
      })

      const listings = yield* Listings.Service

      const row = yield* listings.create({
        productId: c.productId,
        retailerId: c.retailerId,
        url: c.url("/item"),
        variantIds: [variant.id],
      })

      expect(
        (yield* listings.update({
          listingId: row.id,
          command: { cadence: "daily" },
        })).variantIds,
      ).toEqual([variant.id])
      expect(
        (yield* listings.update({
          listingId: row.id,
          command: { variantIds: [] },
        })).variantIds,
      ).toEqual([])
    }),
  )

  for (const container of ["Brand", "Product", "Retailer"] as const) {
    it.effect(`is effectively paused by its ${container}`, () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const listings = yield* Listings.Service

        const row = yield* listings.create({
          productId: c.productId,
          retailerId: c.retailerId,
          url: c.url("/item"),
        })

        if (container === "Brand") {
          const brands = yield* Brands.Service
          yield* brands.update({
            brandId: c.brandId,
            command: { paused: true },
          })
        }

        if (container === "Product") {
          const products = yield* Products.Service
          yield* products.update({
            productId: c.productId,
            command: { paused: true },
          })
        }

        if (container === "Retailer") {
          const retailers = yield* Retailers.Service
          yield* retailers.update({
            retailerId: c.retailerId,
            command: { paused: true },
          })
        }

        expect(
          (yield* listings.get({ listingId: row.id })).effectivePaused,
        ).toBe(true)
        expect((yield* listings.list())[0]?.effectivePaused).toBe(true)
      }),
    )
  }

  it.effect(
    "uses the newest Scrape and its latest Extraction for dominant-failure status",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const listings = yield* Listings.Service

        const row = yield* listings.create({
          productId: c.productId,
          retailerId: c.retailerId,
          url: c.url("/item"),
        })

        const parent = Scrape.Parent.members[0].make({ listingId: row.id })
        yield* history(parent, "failed", "3 hours")
        expect(
          (yield* listings.get({ listingId: row.id })).combinedStatus,
        ).toBe("failed")
        const current = yield* history(parent, "success", "1 hour")
        expect(
          (yield* listings.get({ listingId: row.id })).combinedStatus,
        ).toBe("success")
        yield* extraction(current.id, 1, "success", { age: "45 minutes" })
        expect(
          (yield* listings.get({ listingId: row.id })).combinedStatus,
        ).toBe("success")
        yield* extraction(current.id, 2, "pending", { age: "30 minutes" })
        expect(
          (yield* listings.get({ listingId: row.id })).combinedStatus,
        ).toBe("pending")
        expect((yield* listings.list())[0]?.combinedStatus).toBe("pending")
        const newest = yield* history(parent, "success", "10 minutes")
        yield* extraction(newest.id, 1, "success")
        expect(
          (yield* listings.get({ listingId: row.id })).combinedStatus,
        ).toBe("success")
      }),
  )
  it.effect("filters by Product, Retailer and their intersection", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const a = yield* seed()
      const b = yield* seed()
      const listings = yield* Listings.Service

      const first = yield* listings.create({
        productId: a.productId,
        retailerId: a.retailerId,
        url: a.url("/a"),
      })

      const second = yield* listings.create({
        productId: a.productId,
        retailerId: b.retailerId,
        url: b.url("/b"),
      })

      yield* listings.create({
        productId: b.productId,
        retailerId: b.retailerId,
        url: b.url("/c"),
      })
      expect(
        new Set(
          (yield* listings.list({ productId: a.productId })).map(
            (row) => row.id,
          ),
        ),
      ).toEqual(new Set([first.id, second.id]))
      expect(
        (yield* listings.list({ retailerId: a.retailerId })).map(
          (row) => row.id,
        ),
      ).toEqual([first.id])
      expect(
        (yield* listings.list({
          productId: a.productId,
          retailerId: b.retailerId,
        })).map((row) => row.id),
      ).toEqual([second.id])
    }),
  )
  it.effect(
    "reports a missing Listing for reads, updates, impact and removal",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const listings = yield* Listings.Service

        const id = Schema.decodeUnknownSync(ListingId)(
          "00000000-0000-4000-8000-000000000404",
        )

        const error = new ListingsErrors.NotFound({ listingId: id })
        expect(yield* Effect.flip(listings.get({ listingId: id }))).toEqual(
          error,
        )
        expect(
          yield* Effect.flip(
            listings.update({ listingId: id, command: { variantIds: [] } }),
          ),
        ).toEqual(error)
        expect(yield* Effect.flip(listings.impact({ listingId: id }))).toEqual(
          error,
        )
        expect(yield* Effect.flip(listings.remove({ listingId: id }))).toEqual(
          error,
        )
      }),
  )
})
