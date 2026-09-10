import { describe, expect, it } from "@effect/vitest"
import { Listings } from "@digital-shelf/core/Catalog/Listings"
import { Retailers } from "@digital-shelf/core/Catalog/Retailers"
import * as ListingsRepo from "@digital-shelf/core/Catalog/repositories/ListingsRepo"
import * as RetailersRepo from "@digital-shelf/core/Catalog/repositories/RetailersRepo"
import * as Layers from "@digital-shelf/core/Layers"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import { defaultCadence } from "@digital-shelf/domain/Catalog/Cadence"
import { UrlHostMismatch } from "@digital-shelf/domain/Catalog/Errors"
import { RetailerDomain } from "@digital-shelf/domain/Catalog/Retailer"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as DbTest from "../layers/Db.ts"
import * as PostgresTest from "../layers/Postgres.ts"
import * as R2BucketTest from "../layers/R2Bucket.ts"
import { seed } from "../fixtures/Catalog.ts"

/**
 * The lock contract of the host rule, which PGlite cannot exercise (see
 * HostRule.test.ts): a child write reads the Retailer `FOR SHARE` and a
 * domain change reads it `FOR UPDATE`, so whichever starts second waits for
 * the first's transaction and then judges the URL against what it committed.
 * Runs only when `TEST_DATABASE_URL` names a disposable PostgreSQL
 * (test/layers/Postgres.ts): `vp test --run` in this package with the
 * variable set, as CI does over its service container. Without it the block
 * is skipped, and the skip is reported as such.
 */
const layer = Layers.Catalog.pipe(
  Layer.provideMerge(
    Layer.mergeAll(PostgresTest.layerTest, R2BucketTest.layerTest),
  ),
)

const domain = Schema.decodeUnknownSync(RetailerDomain)

/** A Brand and Product to hang children off, plus a Retailer on `domain`. */
const catalog = Effect.fn("HostRuleFixture.catalog")(function* (
  domain: string,
) {
  const base = yield* seed()
  const retailer = yield* (yield* Retailers).create({ name: "Shop", domain })
  return { ...base, retailerId: retailer.id, domain: retailer.domain }
})

/**
 * Run `body` inside a transaction on a connection of its own and keep that
 * transaction open: `held` resolves once `body` has run, `commit` lets the
 * transaction finish. Nothing else joins it, since the reserved connection
 * travels only in the forked fiber's services.
 */
const holdOpen = <A, E>(body: Effect.Effect<A, E, Db>) =>
  Effect.gen(function* () {
    const db = yield* Db
    const release = yield* Deferred.make<void>()
    const ran = yield* Deferred.make<A, E>()
    const fiber = yield* Effect.forkChild(
      db.transaction(() =>
        body.pipe(
          Effect.exit,
          Effect.tap((exit) => Deferred.done(ran, exit)),
          Effect.flatMap((exit) =>
            Effect.andThen(
              Deferred.await(release),
              Exit.isSuccess(exit)
                ? Effect.succeed(exit.value)
                : Effect.failCause(exit.cause),
            ),
          ),
        ),
      ),
    )
    return {
      held: Deferred.await(ran),
      commit: Effect.andThen(
        Deferred.succeed(release, undefined),
        Fiber.join(fiber),
      ),
    }
  })

/** Drizzle types `execute` as the rows; a driver may hand back the result. */
const rowsOf = (result: unknown): ReadonlyArray<unknown> =>
  Array.isArray(result)
    ? result
    : (result as { readonly rows: ReadonlyArray<unknown> }).rows

/** Whether another backend on this database is blocked on a lock. */
const someoneWaits = Effect.gen(function* () {
  const db = yield* Db
  const rows = rowsOf(
    yield* query(
      db.execute(sql`
        select count(*)::int as waiting
        from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
      `),
    ),
  ) as ReadonlyArray<{ waiting: number }>
  return (rows[0]?.waiting ?? 0) > 0
})

/** Poll until a backend blocks on a lock; false if none does in time. */
const blocksWithin = (attempts: number): Effect.Effect<boolean, SqlError, Db> =>
  Effect.gen(function* () {
    if (yield* someoneWaits) return true
    if (attempts === 0) return false
    // Wall-clock time: the test clock of `it.effect` never advances alone.
    yield* Effect.promise(() => new Promise((tick) => setTimeout(tick, 50)))
    return yield* blocksWithin(attempts - 1)
  })

describe.skipIf(PostgresTest.url === undefined)(
  "host rule on PostgreSQL",
  () => {
    it.layer(layer, { timeout: "60 seconds" })("two connections", (it) => {
      it.effect(
        "makes a child write wait for a domain change in flight, then judges it on the new domain",
        () =>
          Effect.gen(function* () {
            yield* DbTest.reset
            const c = yield* catalog("a.example.com")
            const listings = yield* Listings
            const change = yield* holdOpen(
              Effect.gen(function* () {
                yield* RetailersRepo.getForUpdate(c.retailerId)
                yield* RetailersRepo.update(c.retailerId, {
                  domain: domain("b.example.com"),
                })
              }),
            )
            yield* change.held
            const write = yield* Effect.forkChild(
              Effect.flip(
                listings.create({
                  productId: c.productId,
                  retailerId: c.retailerId,
                  url: "https://a.example.com/p/1",
                }),
              ),
            )
            expect(yield* blocksWithin(100)).toBe(true)
            yield* change.commit
            expect(yield* Fiber.join(write)).toEqual(
              new UrlHostMismatch({
                url: "https://a.example.com/p/1",
                domain: "b.example.com",
                listingIds: [],
                pageIds: [],
              }),
            )
            expect(yield* listings.list()).toEqual([])
          }),
        30_000,
      )

      it.effect(
        "makes a domain change wait for a child write in flight, then refuses it naming the child",
        () =>
          Effect.gen(function* () {
            yield* DbTest.reset
            const c = yield* catalog("a.example.com")
            const retailers = yield* Retailers
            const write = yield* holdOpen(
              Effect.gen(function* () {
                yield* RetailersRepo.getForShare(c.retailerId)
                return yield* ListingsRepo.insert({
                  productId: c.productId,
                  retailerId: c.retailerId,
                  url: "https://a.example.com/p/1",
                  cadence: defaultCadence,
                })
              }),
            )
            const row = yield* write.held
            const change = yield* Effect.forkChild(
              Effect.flip(
                retailers.update(c.retailerId, { domain: "b.example.com" }),
              ),
            )
            expect(yield* blocksWithin(100)).toBe(true)
            yield* write.commit
            expect(yield* Fiber.join(change)).toEqual(
              new UrlHostMismatch({
                url: "https://a.example.com/p/1",
                domain: "b.example.com",
                listingIds: [row.id],
                pageIds: [],
              }),
            )
            expect((yield* retailers.get(c.retailerId)).domain).toBe(
              "a.example.com",
            )
            expect((yield* (yield* Listings).get(row.id)).url).toBe(
              "https://a.example.com/p/1",
            )
          }),
        30_000,
      )
    })
  },
)
