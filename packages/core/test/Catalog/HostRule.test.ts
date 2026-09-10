import { expect, it } from "@effect/vitest"
import { Listings } from "@digital-shelf/core/Catalog/Listings"
import { Pages } from "@digital-shelf/core/Catalog/Pages"
import { Retailers } from "@digital-shelf/core/Catalog/Retailers"
import * as RetailersRepo from "@digital-shelf/core/Catalog/repositories/RetailersRepo"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import { UrlHostMismatch } from "@digital-shelf/domain/Catalog/Errors"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import * as CoreTest from "../layers/Core.ts"
import * as DbTest from "../layers/Db.ts"
import { catalog, rowsOf } from "../fixtures/Catalog.ts"

/** The `url` column of a Listing as the table holds it. */
const storedUrl = Effect.fn("HostRuleFixture.storedUrl")(function* (
  id: string,
) {
  const db = yield* Db
  const rows = rowsOf(
    yield* query(db.execute(sql`select url from listings where id = ${id}`)),
  ) as ReadonlyArray<{ url: string }>
  return rows[0]?.url
})

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })("host rule", (it) => {
  it.effect("refuses a Listing whose URL sits off the Retailer's domain", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* catalog("bigw.com.au")
      const listings = yield* Listings
      const command = {
        productId: c.productId,
        retailerId: c.retailerId,
        url: "https://evilbigw.com.au/p/123",
      }
      expect(yield* Effect.flip(listings.create(command))).toEqual(
        new UrlHostMismatch({
          url: "https://evilbigw.com.au/p/123",
          domain: "bigw.com.au",
          listingIds: [],
          pageIds: [],
        }),
      )
      expect(yield* listings.list()).toEqual([])
    }),
  )

  it.effect("accepts a subdomain and a `www.` on either side", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* catalog("www.BigW.com.au")
      expect(c.domain).toBe("bigw.com.au")
      const listings = yield* Listings
      for (const url of [
        "https://www.bigw.com.au/p/1",
        "https://bigw.com.au/p/2",
        "https://shop.bigw.com.au/p/3",
      ])
        yield* listings.create({
          productId: c.productId,
          retailerId: c.retailerId,
          url,
        })
      expect(yield* listings.list()).toHaveLength(3)
    }),
  )

  it.effect("refuses a URL change off the domain, leaving it stored", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* catalog("bigw.com.au")
      const listings = yield* Listings
      const row = yield* listings.create({
        productId: c.productId,
        retailerId: c.retailerId,
        url: "https://www.bigw.com.au/p/1",
      })
      expect(
        yield* Effect.flip(
          listings.update(row.id, { url: "https://coles.com.au/p/1" }),
        ),
      ).toEqual(
        new UrlHostMismatch({
          url: "https://coles.com.au/p/1",
          domain: "bigw.com.au",
          listingIds: [],
          pageIds: [],
        }),
      )
      expect((yield* listings.get(row.id)).url).toBe(
        "https://www.bigw.com.au/p/1",
      )
    }),
  )

  it.effect("stores the normalised bytes of a URL handed to core as is", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* catalog("bigw.com.au")
      const listings = yield* Listings
      const row = yield* listings.create({
        productId: c.productId,
        retailerId: c.retailerId,
        url: "  HTTPS://WWW.BigW.com.au/p/1?utm_source=a&th=1  ",
      })
      yield* listings.update(row.id, {
        url: "  HTTPS://WWW.BigW.com.au/p/2?utm_source=a&th=1  ",
      })
      // The column itself, not the entity schema's reading of it: that
      // reading normalises too and would hide raw bytes on disk.
      expect(yield* storedUrl(row.id)).toBe("https://www.bigw.com.au/p/2?th=1")
    }),
  )

  it.effect("refuses a Page on create and on a URL change", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* catalog("bigw.com.au")
      const pages = yield* Pages
      expect(
        yield* Effect.flip(
          pages.create({
            brandId: c.brandId,
            retailerId: c.retailerId,
            url: "https://coles.com.au/brand/gaia",
          }),
        ),
      ).toEqual(
        new UrlHostMismatch({
          url: "https://coles.com.au/brand/gaia",
          domain: "bigw.com.au",
          listingIds: [],
          pageIds: [],
        }),
      )
      const row = yield* pages.create({
        brandId: c.brandId,
        retailerId: c.retailerId,
        url: "https://www.bigw.com.au/brand/gaia",
      })
      expect(
        yield* Effect.flip(
          pages.update(row.id, { url: "https://bigw.com.au.evil.com/x" }),
        ),
      ).toEqual(
        new UrlHostMismatch({
          url: "https://bigw.com.au.evil.com/x",
          domain: "bigw.com.au",
          listingIds: [],
          pageIds: [],
        }),
      )
      expect((yield* pages.get(row.id)).url).toBe(
        "https://www.bigw.com.au/brand/gaia",
      )
    }),
  )

  it.effect(
    "refuses a Retailer domain change that would strand children, naming them",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* catalog("a.example.com")
        const listing = yield* (yield* Listings).create({
          productId: c.productId,
          retailerId: c.retailerId,
          url: "https://a.example.com/p/1",
        })
        const page = yield* (yield* Pages).create({
          brandId: c.brandId,
          retailerId: c.retailerId,
          url: "https://a.example.com/brand",
        })
        const retailers = yield* Retailers
        expect(
          yield* Effect.flip(
            retailers.update(c.retailerId, { domain: "b.example.com" }),
          ),
        ).toEqual(
          new UrlHostMismatch({
            url: "https://a.example.com/p/1",
            domain: "b.example.com",
            listingIds: [listing.id],
            pageIds: [page.id],
          }),
        )
        expect((yield* retailers.get(c.retailerId)).domain).toBe(
          "a.example.com",
        )
        // Widening to the parent domain keeps every child valid, so it passes.
        expect(
          (yield* retailers.update(c.retailerId, { domain: "example.com" }))
            .domain,
        ).toBe("example.com")
        // A change that touches no domain never inspects the children.
        expect(
          (yield* retailers.update(c.retailerId, { name: "Renamed" })).name,
        ).toBe("Renamed")
      }),
  )

  /**
   * The lock itself. PGlite runs one PostgreSQL backend behind a semaphore of
   * one (`@effect/sql-pglite`), so two transactions never overlap here and
   * nothing in this file can watch one write block on the other: that proof
   * is HostRule.postgres.test.ts, over a real PostgreSQL with two
   * connections. What is provable in process is that the reads request real
   * row locks, which `pg_locks` reports while the transaction holds them, and
   * that the rule holds whichever of the two writes runs first.
   */
  const locksHeld = Effect.fn("HostRuleFixture.locksHeld")(function* (
    read: Effect.Effect<unknown, never, Db>,
  ) {
    const db = yield* Db
    const result: unknown = yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* read
        return yield* query(
          db.execute(sql`
            select l.mode
            from pg_locks l
            join pg_class c on c.oid = l.relation
            where c.relname = 'retailers'
          `),
        )
      }),
    )
    return (rowsOf(result) as ReadonlyArray<{ mode: string }>).map(
      (row) => row.mode,
    )
  })

  it.effect("reads the Retailer under a row lock, not as a plain select", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const c = yield* catalog("bigw.com.au")
      // A plain read takes only AccessShareLock, which blocks nothing.
      expect(
        yield* locksHeld(RetailersRepo.get(c.retailerId).pipe(Effect.orDie)),
      ).toEqual(["AccessShareLock"])
      // Both locking reads make PostgreSQL take a row lock on the table; the
      // tuple-level difference between SHARE and UPDATE only becomes visible
      // to a second connection, which PGlite cannot give us.
      for (const read of [
        RetailersRepo.getForShare(c.retailerId),
        RetailersRepo.getForUpdate(c.retailerId),
      ])
        expect(yield* locksHeld(read.pipe(Effect.orDie))).toContain(
          "RowShareLock",
        )
    }),
  )

  it.effect(
    "holds the rule whichever of a child write and a domain change runs first",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const listings = yield* Listings
        const retailers = yield* Retailers

        // Child first: the domain change then sees it and is refused by id.
        const first = yield* catalog("a.example.com")
        const row = yield* listings.create({
          productId: first.productId,
          retailerId: first.retailerId,
          url: "https://a.example.com/p/1",
        })
        expect(
          yield* Effect.flip(
            retailers.update(first.retailerId, { domain: "b.example.com" }),
          ),
        ).toEqual(
          new UrlHostMismatch({
            url: "https://a.example.com/p/1",
            domain: "b.example.com",
            listingIds: [row.id],
            pageIds: [],
          }),
        )
        expect((yield* listings.get(row.id)).url).toBe(
          "https://a.example.com/p/1",
        )

        // Domain change first: the child write then reads the new domain and
        // is refused.
        const second = yield* catalog("c.example.com")
        yield* retailers.update(second.retailerId, { domain: "d.example.com" })
        expect(
          yield* Effect.flip(
            listings.create({
              productId: second.productId,
              retailerId: second.retailerId,
              url: "https://c.example.com/p/1",
            }),
          ),
        ).toEqual(
          new UrlHostMismatch({
            url: "https://c.example.com/p/1",
            domain: "d.example.com",
            listingIds: [],
            pageIds: [],
          }),
        )
      }),
  )
})
