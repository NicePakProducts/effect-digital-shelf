import { RetailersErrors, Retailers } from "@app/core/retailers"
import { describe, expect, it } from "@effect/vitest"
import { Listings } from "@app/core/listings"
import { RetailersRepo } from "../../src/retailers/repository"
import * as Layers from "../layers/Features"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { Retailer } from "@app/schema/retailer"
import { sql } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as DbTest from "../layers/Db"
import * as PostgresTest from "../layers/Postgres"
import * as R2BucketTest from "../layers/R2Bucket"
import { catalog, rowsOf } from "../fixtures/Catalog"

/**
 * The lock contract of the host rule, which PGlite cannot exercise (see
 * HostRule.test.ts): a child write reads the Retailer `FOR SHARE` and a
 * domain change reads it `FOR UPDATE`, so whichever starts second waits for
 * the first's transaction and then judges the URL against what it committed.
 * Runs only when `DIGITAL_SHELF_TEST_POSTGRES_URL` names a disposable PostgreSQL
 * (test/layers/Postgres.ts): `vp test --run` in this package with the
 * variable set, as CI does over its service container. Without it the block
 * is skipped, and the skip is reported as such.
 */
const TestLayer = Layers.CatalogLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(PostgresTest.TestLayer, R2BucketTest.TestLayer),
  ),
)

const domain = Schema.decodeUnknownSync(Retailer.Domain)

/**
 * Run `body` inside a transaction on a connection of its own and keep that
 * transaction open: `held` resolves once `body` has run, `commit` lets the
 * transaction finish. A service call inside `body` joins it as a savepoint,
 * since the reserved connection travels in the forked fiber's services, so
 * the lock it takes is the service's own and stays held until `commit`.
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

/** Whether another backend on this database is blocked on a lock. */
const someoneWaits = Effect.gen(function* () {
  const db = yield* Db

  // SAFETY: The query casts count(*) to int and aliases the single result as waiting.
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
    it.layer(TestLayer, { timeout: "60 seconds" })("two connections", (it) => {
      it.effect(
        "makes a child write wait for a domain change in flight, then judges it on the new domain",
        () =>
          Effect.gen(function* () {
            yield* DbTest.reset
            const c = yield* catalog("a.example.com")
            const listings = yield* Listings.Service
            const retailersRepo = yield* RetailersRepo.Service

            const change = yield* holdOpen(
              Effect.gen(function* () {
                yield* retailersRepo.getForUpdate(c.retailerId)
                yield* retailersRepo.update(c.retailerId, {
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
              new RetailersErrors.UrlHostMismatch({
                url: "https://a.example.com/p/1",
                domain: "b.example.com",
                listingIds: [],
                pageIds: [],
              }),
            )
            expect(yield* listings.list()).toEqual([])
          }).pipe(Effect.provide(RetailersRepo.layer)),
        30_000,
      )

      it.effect(
        "makes a domain change wait for a child write in flight, then refuses it naming the child",
        () =>
          Effect.gen(function* () {
            yield* DbTest.reset
            const c = yield* catalog("a.example.com")
            const retailers = yield* Retailers.Service
            const listings = yield* Listings.Service

            const write = yield* holdOpen(
              listings.create({
                productId: c.productId,
                retailerId: c.retailerId,
                url: "https://a.example.com/p/1",
              }),
            )

            const row = yield* write.held

            const change = yield* Effect.forkChild(
              Effect.flip(
                retailers.update({
                  retailerId: c.retailerId,
                  command: { domain: "b.example.com" },
                }),
              ),
            )

            expect(yield* blocksWithin(100)).toBe(true)
            yield* write.commit
            expect(yield* Fiber.join(change)).toEqual(
              new RetailersErrors.UrlHostMismatch({
                url: "https://a.example.com/p/1",
                domain: "b.example.com",
                listingIds: [row.id],
                pageIds: [],
              }),
            )
            expect(
              (yield* retailers.get({ retailerId: c.retailerId })).domain,
            ).toBe("a.example.com")
            expect((yield* listings.get({ listingId: row.id })).url).toBe(
              "https://a.example.com/p/1",
            )
          }),
        30_000,
      )
    })
  },
)
