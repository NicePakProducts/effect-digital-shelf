import * as Predicate from "effect/Predicate"
import { expect, it } from "@effect/vitest"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import {
  ScrapeRunner,
  FetchOutcome,
  TransitionRejected,
} from "@digital-shelf/core/Scraping/ScrapeRunner"
import { ExtractionsRepo } from "@digital-shelf/core/Scraping/repositories/ExtractionsRepo"
import { ScrapeProviderError } from "@digital-shelf/core/Providers/ScrapeProviders"
import { Db } from "@digital-shelf/core/Sql/Db"
import { query } from "@digital-shelf/core/Sql/Errors"
import {
  extractions,
  scrapes as scrapeTable,
} from "@digital-shelf/domain/Sql/Scraping"
import { listings } from "@digital-shelf/domain/Sql/Catalog"
import { eq } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import { ScrapeProvidersTest, fetched } from "../layers/ScrapeProviders.ts"
import { R2BucketTest } from "../layers/R2Bucket.ts"
import { reset, seed } from "../fixtures/Scraping.ts"

const setup = Effect.gen(function* () {
  yield* reset
  const seededCatalog = yield* seed()
  const target = yield* seededCatalog.listing
  const scrapes = yield* Scrapes
  const row = yield* scrapes.trigger({ parent: target.parent })

  return { target, scrapes, row, runner: yield* ScrapeRunner }
})

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "ScrapeRunner",
  (it) => {
    it.effect(
      "retailer advance defaults are stored and forwarded to the provider",
      () =>
        Effect.gen(function* () {
          yield* reset

          const seededCatalog = yield* seed({
            mode: "advance",
            country: "Canada",
          })

          const listing = yield* seededCatalog.listing
          const parent = listing.parent
          const url = listing.url

          const scrapes = yield* Scrapes
          const row = yield* scrapes.trigger({ parent })
          expect(row.mode).toBe("advance")
          expect(row.country).toEqual(Option.some("Canada"))
          const runner = yield* ScrapeRunner
          const claimed = yield* runner.claim(row.id)
          expect(claimed.country).toBe("Canada")
          yield* runner.fetch(row.id, claimed)
          const scrapeProvidersTest = yield* ScrapeProvidersTest
          expect(yield* scrapeProvidersTest.requests).toEqual([
            {
              mode: "advance",
              request: { url, country: Option.some("Canada") },
            },
          ])
        }),
    )
    it.effect(
      "catch-all leaves both terminal states completely unchanged",
      () =>
        Effect.gen(function* () {
          const setupResult = yield* setup
          const row = setupResult.row
          const runner = setupResult.runner
          const scrapes = setupResult.scrapes
          const target = setupResult.target

          const fetched = yield* runner.fetch(
            row.id,
            yield* runner.claim(row.id),
          )

          yield* runner.finish(row.id, fetched)
          const successful = yield* scrapes.get({ scrapeId: row.id })
          yield* TestClock.adjust("1 second")
          yield* runner.fail(row.id, "unknown", "after commit")
          expect(yield* scrapes.get({ scrapeId: row.id })).toEqual(successful)
          const next = yield* scrapes.trigger({ parent: target.parent })
          yield* runner.fail(next.id, "timeout", "first failure")
          const failed = yield* scrapes.get({ scrapeId: next.id })
          yield* TestClock.adjust("1 second")
          yield* runner.fail(next.id, "unknown", "later failure")
          expect(yield* scrapes.get({ scrapeId: next.id })).toEqual(failed)
        }),
    )
    it.effect(
      "rejected finish preserves TransitionRejected if object cleanup fails",
      () =>
        Effect.gen(function* () {
          const setupResult = yield* setup
          const row = setupResult.row
          const runner = setupResult.runner

          const outcome = yield* runner.fetch(
            row.id,
            yield* runner.claim(row.id),
          )

          yield* runner.fail(row.id, "timeout", "swept")
          const bucketTest = yield* R2BucketTest
          yield* bucketTest.failNextDelete
          expect(
            yield* Effect.flip(runner.finish(row.id, outcome)),
          ).toBeInstanceOf(TransitionRejected)
        }),
    )
    it.effect(
      "happy path stores objects, advances the parent and atomically creates one pinned Extraction; steps replay",
      () =>
        Effect.gen(function* () {
          const extractionsRepo = yield* ExtractionsRepo

          const setupResult = yield* setup
          const row = setupResult.row
          const runner = setupResult.runner
          const scrapes = setupResult.scrapes
          const target = setupResult.target
          const claimed = yield* runner.claim(row.id)

          const firstStartedAt = (yield* scrapes.get({ scrapeId: row.id }))
            .startedAt

          yield* TestClock.adjust("1 second")
          expect(yield* runner.claim(row.id)).toEqual(claimed)
          expect((yield* scrapes.get({ scrapeId: row.id })).startedAt).toEqual(
            firstStartedAt,
          )
          const outcome = yield* runner.fetch(row.id, claimed)
          expect(
            Schema.is(FetchOutcome)(JSON.parse(JSON.stringify(outcome))),
          ).toBe(true)
          const result = yield* runner.finish(row.id, outcome)
          expect(result.extractionId).not.toBeNull()
          expect(yield* runner.finish(row.id, outcome)).toEqual(result)
          expect((yield* scrapes.get({ scrapeId: row.id })).status).toBe(
            "success",
          )
          const db = yield* Db
          const rows = yield* query(db.select().from(extractions))
          expect(rows).toHaveLength(1)
          expect(rows[0]).toMatchObject({
            status: "pending",
            model: "@cf/zai-org/glm-4.7-flash",
            promptSnapshot: "Extract listing",
            attempt: 1,
          })

          const parentRows = yield* query(
            db
              .select()
              .from(listings)
              .where(eq(listings.id, target.parent.listingId)),
          )

          expect(parentRows[0]?.lastScrapedAt).toEqual(
            DateTime.toDateUtc(yield* DateTime.now),
          )
          const bucketTest = yield* R2BucketTest
          const objects = yield* bucketTest.inspect
          expect(objects.get(`html/${row.id}.html`)?.contentType).toBe(
            "text/html",
          )
          expect(objects.get(`raw/${row.id}.json`)?.contentType).toBe(
            "application/json",
          )

          const initial = Option.getOrThrow(
            yield* extractionsRepo.findInitial(row.id),
          )

          yield* runner.startExtraction(initial.id, row.id)
          yield* runner.startExtraction(initial.id, row.id)
          const executionsTest = yield* ExecutionsTest
          const calls = yield* executionsTest.calls
          expect(
            calls.filter((call) => call.kind === "extraction")[0]?.instances,
          ).toEqual([
            {
              id: initial.id,
              traceparent: `00-${row.id.replaceAll("-", "")}-${row.rootSpanId}-01`,
            },
          ])
          yield* query(
            db
              .update(extractions)
              .set({
                status: "success",
                updatedAt: DateTime.toDateUtc(yield* DateTime.now),
              })
              .where(eq(extractions.id, initial.id)),
          )
          expect(yield* runner.finish(row.id, outcome)).toEqual(result)
        }).pipe(Effect.provide([ExtractionsRepo.layer])),
    )
    it.effect("a late finish cannot resurrect a failed Scrape", () =>
      Effect.gen(function* () {
        const extractionsRepo = yield* ExtractionsRepo

        const setupResult = yield* setup
        const row = setupResult.row
        const runner = setupResult.runner
        const scrapes = setupResult.scrapes
        const claimed = yield* runner.claim(row.id)
        const outcome = yield* runner.fetch(row.id, claimed)
        yield* runner.fail(row.id, "unknown", "execution failed")
        yield* runner.fail(row.id, "unknown", "replay")
        expect(
          yield* Effect.flip(runner.finish(row.id, outcome)),
        ).toBeInstanceOf(TransitionRejected)
        expect((yield* scrapes.get({ scrapeId: row.id })).status).toBe("failed")
        const bucketTest = yield* R2BucketTest
        const objects = yield* bucketTest.inspect
        expect(objects.has(`html/${row.id}.html`)).toBe(false)
        expect(objects.has(`raw/${row.id}.json`)).toBe(false)
        expect(Option.isNone(yield* extractionsRepo.findInitial(row.id))).toBe(
          true,
        )
      }).pipe(Effect.provide([ExtractionsRepo.layer])),
    )
    it.effect("the provider deadline is driven by TestClock", () =>
      Effect.gen(function* () {
        const setupResult = yield* setup
        const row = setupResult.row
        const runner = setupResult.runner
        const target = setupResult.target
        const scrapeProvidersTest = yield* ScrapeProvidersTest
        yield* scrapeProvidersTest.script(
          target.url,
          Effect.sleep("10 minutes").pipe(Effect.as(fetched(target.url))),
        )
        const claimed = yield* runner.claim(row.id)

        const fiber = yield* runner
          .fetch(row.id, claimed)
          .pipe(Effect.forkChild)

        yield* TestClock.adjust("181 seconds")
        expect(yield* Fiber.join(fiber)).toMatchObject({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
          _tag: "failed",
          code: "timeout",
          attempts: 1,
        })
      }),
    )
    it.effect("inner text is capped at a UTF-8 character boundary", () =>
      Effect.gen(function* () {
        const setupResult = yield* setup
        const row = setupResult.row
        const runner = setupResult.runner
        const target = setupResult.target
        const result = fetched(target.url)
        const scrapeProvidersTest = yield* ScrapeProvidersTest
        yield* scrapeProvidersTest.script(
          target.url,
          Effect.succeed({
            ...result,
            envelope: { ...result.envelope, innerText: "€".repeat(102400) },
          }),
        )
        const outcome = yield* runner.fetch(row.id, yield* runner.claim(row.id))
        expect(outcome._tag).toBe("fetched")

        if (!Predicate.isTagged(outcome, "fetched")) return
        expect(outcome.truncated).toBe(true)
        expect(
          new TextEncoder().encode(outcome.envelope.innerText).length,
        ).toBe(262143)
        expect(outcome.envelope.innerText.includes("�")).toBe(false)
      }),
    )
    it.effect("provider failures are JSON-safe and persist their code", () =>
      Effect.gen(function* () {
        const setupResult = yield* setup
        const row = setupResult.row
        const runner = setupResult.runner
        const target = setupResult.target
        const scrapes = setupResult.scrapes
        const scrapeProvidersTest = yield* ScrapeProvidersTest
        yield* scrapeProvidersTest.script(
          target.url,
          Effect.fail(
            new ScrapeProviderError({
              code: "blocked",
              message: "blocked",
              retryable: false,
              attempts: 2,
              detail: { status: 403 },
            }),
          ),
        )
        const outcome = yield* runner.fetch(row.id, yield* runner.claim(row.id))
        expect(outcome).toMatchObject({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
          _tag: "failed",
          code: "blocked",
          detail: { status: 403 },
        })
        expect(yield* runner.finish(row.id, outcome)).toEqual({
          extractionId: null,
        })
        expect(yield* runner.finish(row.id, outcome)).toEqual({
          extractionId: null,
        })
        const saved = yield* scrapes.get({ scrapeId: row.id })
        expect(saved.errorCode).toEqual(Option.some("blocked"))
        expect(saved.attempts).toEqual(Option.some(2))
      }),
    )
    it.effect(
      "catch-all can fail before claim and claim uses dispatch snapshots",
      () =>
        Effect.gen(function* () {
          const setupResult = yield* setup
          const row = setupResult.row
          const runner = setupResult.runner
          const scrapes = setupResult.scrapes
          yield* runner.fail(row.id, "unknown", "before claim")
          expect((yield* scrapes.get({ scrapeId: row.id })).status).toBe(
            "failed",
          )
          expect(yield* Effect.flip(runner.claim(row.id))).toBeInstanceOf(
            TransitionRejected,
          )
        }),
    )
    it.effect(
      "finish rolls back success if initial Extraction insertion fails",
      () =>
        Effect.gen(function* () {
          const extractionsRepo = yield* ExtractionsRepo

          const setupResult = yield* setup
          const row = setupResult.row
          const runner = setupResult.runner
          const scrapes = setupResult.scrapes

          const outcome = yield* runner.fetch(
            row.id,
            yield* runner.claim(row.id),
          )

          const now = yield* DateTime.now
          yield* extractionsRepo.insert({
            scrapeId: row.id,
            attempt: 1,
            status: "pending",
            model: "collision",
            promptKind: "listing",
            promptSnapshot: "test",
            createdAt: now,
            updatedAt: now,
          })
          yield* Effect.flip(runner.finish(row.id, outcome))
          expect((yield* scrapes.get({ scrapeId: row.id })).status).toBe(
            "running",
          )
          const db = yield* Db
          expect(
            (yield* query(db.select().from(scrapeTable)))[0]?.finishedAt,
          ).toBeNull()
        }).pipe(Effect.provide([ExtractionsRepo.layer])),
    )
  },
)
