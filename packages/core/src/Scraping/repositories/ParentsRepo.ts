import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  ListingNotFound,
  PageNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import { Cadence, Cadences } from "@digital-shelf/domain/Catalog/Cadence"
import { ScrapeParent } from "@digital-shelf/domain/Scraping/Scrape"
import type { BulkScrape } from "@digital-shelf/domain/Scraping/ScrapingManagement"
import {
  ScrapeMode,
  ScrapeStatus,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import { ListingId, PageId, RetailerId } from "@digital-shelf/domain/Shared/Ids"
import { Timestamp, nullable } from "@digital-shelf/domain/Shared/Refine"
import {
  brands,
  listings,
  pages,
  products,
  retailers,
} from "@digital-shelf/domain/Sql/Catalog"
import { scrapes } from "@digital-shelf/domain/Sql/Scraping"
import { and, asc, desc, eq, notExists, sql, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { cadenceInterval } from "../../Sql/Cadence.ts"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Parents as the scraping lifecycle sees them: a Listing or Page joined to
 * its Retailer's scrape defaults and prompt, with effective pause resolved
 * from the containers. Selection (cadence-due, bulk scope) lives here in
 * SQL; the arithmetic it mirrors is Scheduling/CadenceDue.ts.
 */

/** A Parent with everything a dispatch snapshots onto the Scrape. */
export const ScrapeTarget = Schema.Struct({
  parentKind: Schema.Literals(["listing", "page"]),
  listingId: nullable(ListingId),
  pageId: nullable(PageId),
  retailerId: RetailerId,
  url: Schema.String,
  cadence: Cadence,
  mode: ScrapeMode,
  country: Schema.String,
  /** The Retailer's Extraction prompt for this Parent kind. */
  prompt: Schema.String,
  paused: Schema.Boolean,
  /** The Parent's most recent Scrape of any status, the cadence anchor. */
  anchorAt: nullable(Timestamp),
  anchorStatus: nullable(ScrapeStatus),
})

export type ScrapeTarget = typeof ScrapeTarget.Type

export const parentOf = (target: ScrapeTarget): ScrapeParent =>
  Option.match(target.listingId, {
    onSome: (listingId) => ScrapeParent.members[0].make({ listingId }),
    onNone: () =>
      ScrapeParent.members[1].make({
        pageId: Option.getOrThrow(target.pageId),
      }),
  })

const decodeTargets = Rows.decodeAll(ScrapeTarget)

const tsz = (at: DateTime.Utc): SQL =>
  sql`${DateTime.formatIso(at)}::timestamptz`

const interval = (duration: Duration.Duration): SQL =>
  sql`make_interval(secs => ${Duration.toSeconds(duration)}::double precision)`

/** `CASE <cadence> WHEN 'daily' THEN interval ... END` from the one table. */
const cadenceIntervalSql = (column: AnyPgColumn | SQL): SQL =>
  sql`(CASE ${column} ${sql.join(
    Cadences.map(
      (cadence) =>
        sql`WHEN ${cadence} THEN ${interval(cadenceInterval[cadence])}`,
    ),
    sql` `,
  )} END)`

/** The pause and scrape columns every Parent query joins. */
const listingBase = (db: Db["Service"]) => {
  const last = db
    .select({ createdAt: scrapes.createdAt, status: scrapes.status })
    .from(scrapes)
    .where(eq(scrapes.listingId, listings.id))
    .orderBy(desc(scrapes.createdAt), desc(scrapes.id))
    .limit(1)
    .as("last")

  const select = db
    .select({
      parentKind: sql<"listing">`'listing'`,
      listingId: listings.id,
      pageId: sql<null>`NULL::uuid`,
      retailerId: listings.retailerId,
      url: listings.url,
      cadence: listings.cadence,
      mode: retailers.scrapeMode,
      country: retailers.scrapeCountry,
      prompt: retailers.listingExtractPrompt,
      paused: sql<boolean>`(${brands.paused} OR ${products.paused} OR ${retailers.paused})`,
      anchorAt: last.createdAt,
      anchorStatus: last.status,
    })
    .from(listings)
    .innerJoin(products, eq(products.id, listings.productId))
    .innerJoin(brands, eq(brands.id, products.brandId))
    .innerJoin(retailers, eq(retailers.id, listings.retailerId))
    .leftJoinLateral(last, sql`true`)

  return { select, last }
}

const pageBase = (db: Db["Service"]) => {
  const last = db
    .select({ createdAt: scrapes.createdAt, status: scrapes.status })
    .from(scrapes)
    .where(eq(scrapes.pageId, pages.id))
    .orderBy(desc(scrapes.createdAt), desc(scrapes.id))
    .limit(1)
    .as("last")

  const select = db
    .select({
      parentKind: sql<"page">`'page'`,
      listingId: sql<null>`NULL::uuid`,
      pageId: pages.id,
      retailerId: pages.retailerId,
      url: pages.url,
      cadence: pages.cadence,
      mode: retailers.scrapeMode,
      country: retailers.scrapeCountry,
      prompt: retailers.pageExtractPrompt,
      paused: sql<boolean>`(${brands.paused} OR ${retailers.paused} OR ${pages.paused})`,
      anchorAt: last.createdAt,
      anchorStatus: last.status,
    })
    .from(pages)
    .innerJoin(brands, eq(brands.id, pages.brandId))
    .innerJoin(retailers, eq(retailers.id, pages.retailerId))
    .leftJoinLateral(last, sql`true`)

  return { select, last }
}

const listingNotInFlight = notExists(
  sql`(SELECT 1 FROM ${scrapes} WHERE ${scrapes.listingId} = ${listings.id} AND ${scrapes.status} IN ('pending', 'running'))`,
)

const pageNotInFlight = notExists(
  sql`(SELECT 1 FROM ${scrapes} WHERE ${scrapes.pageId} = ${pages.id} AND ${scrapes.status} IN ('pending', 'running'))`,
)

/** Never-scraped first, then oldest anchor first; ids break ties. */
const byAnchor = (a: ScrapeTarget, b: ScrapeTarget): number => {
  const aAt = Option.map(a.anchorAt, DateTime.toEpochMillis)
  const bAt = Option.map(b.anchorAt, DateTime.toEpochMillis)

  if (Option.isNone(aAt) && Option.isNone(bAt))
    return idOf(a) < idOf(b) ? -1 : 1

  if (Option.isNone(aAt)) return -1

  if (Option.isNone(bAt)) return 1

  return aAt.value - bAt.value || (idOf(a) < idOf(b) ? -1 : 1)
}

const idOf = (target: ScrapeTarget): string =>
  Option.getOrElse(target.listingId, () => Option.getOrThrow(target.pageId))

export class ParentsRepo extends Context.Service<
  ParentsRepo,
  {
    readonly findTarget: (
      parent: ScrapeParent,
    ) => Effect.Effect<Option.Option<ScrapeTarget>, SqlError>
    readonly getTarget: (
      parent: ScrapeParent,
    ) => Effect.Effect<ScrapeTarget, ListingNotFound | PageNotFound | SqlError>
    readonly cadenceDue: (
      now: DateTime.Utc,
      failureRetryInterval: Duration.Duration,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ScrapeTarget>, SqlError>
    readonly bulkCandidates: (
      scope: BulkScrape,
    ) => Effect.Effect<ReadonlyArray<ScrapeTarget>, SqlError>
    readonly containerExists: (
      scope: BulkScrape,
    ) => Effect.Effect<boolean, SqlError>
    readonly markScraped: (
      parent: ScrapeParent,
      at: DateTime.Utc,
    ) => Effect.Effect<void, SqlError>
  }
>()("@digital-shelf/core/Scraping/repositories/ParentsRepo", {
  make: Effect.gen(function* () {
    const db = yield* Db

    const findTarget = Effect.fn("ParentsRepo.findTarget", {
      level: "Debug",
    })(function* (parent: ScrapeParent) {
      const rows = Predicate.isTagged(parent, "Listing")
        ? yield* query(
            listingBase(db).select.where(eq(listings.id, parent.listingId)),
          )
        : yield* query(pageBase(db).select.where(eq(pages.id, parent.pageId)))

      const targets = yield* decodeTargets(rows)

      return Option.fromUndefinedOr(targets[0])
    })

    const getTarget = Effect.fn("ParentsRepo.getTarget", { level: "Debug" })(
      function* (parent: ScrapeParent) {
        const target = yield* findTarget(parent)

        if (Option.isSome(target)) return target.value

        return yield* Effect.fail(
          Predicate.isTagged(parent, "Listing")
            ? new ListingNotFound({ listingId: parent.listingId })
            : new PageNotFound({ pageId: parent.pageId }),
        )
      },
    )

    /**
     * Cadence-due Parents that are not effectively paused and not in flight,
     * never-scraped first, then oldest anchor first, at most `limit`. Two
     * queries (Listings, Pages) merged in memory: each is bounded by `limit`,
     * so the merge sees at most `2 * limit` rows.
     */
    const cadenceDue = Effect.fn("ParentsRepo.cadenceDue", {
      level: "Debug",
    })(function* (
      now: DateTime.Utc,
      failureRetryInterval: Duration.Duration,
      limit: number,
    ) {
      if (limit <= 0) return []

      const due = (
        last: { readonly createdAt: unknown; readonly status: unknown },
        cadence: AnyPgColumn,
      ): SQL =>
        sql`(${last.createdAt} IS NULL OR ${last.createdAt} + (CASE WHEN ${last.status} = 'failed' THEN LEAST(${cadenceIntervalSql(cadence)}, ${interval(failureRetryInterval)}) ELSE ${cadenceIntervalSql(cadence)} END) <= ${tsz(now)})`

      const l = listingBase(db)
      const p = pageBase(db)

      const listingRows = yield* query(
        l.select
          .where(
            and(
              sql`NOT (${brands.paused} OR ${products.paused} OR ${retailers.paused})`,
              listingNotInFlight,
              due(l.last, listings.cadence),
            ),
          )
          .orderBy(sql`${l.last.createdAt} ASC NULLS FIRST`, asc(listings.id))
          .limit(limit),
      )

      const pageRows = yield* query(
        p.select
          .where(
            and(
              sql`NOT (${brands.paused} OR ${retailers.paused} OR ${pages.paused})`,
              pageNotInFlight,
              due(p.last, pages.cadence),
            ),
          )
          .orderBy(sql`${p.last.createdAt} ASC NULLS FIRST`, asc(pages.id))
          .limit(limit),
      )

      const targets = yield* decodeTargets([...listingRows, ...pageRows])

      return [...targets].sort(byAnchor).slice(0, limit)
    })

    /**
     * Every Parent under a bulk scope, cadence ignored, each carrying its
     * effective pause. Paused and in-flight candidates reach the caller so bulk
     * can report both as skipped. A Product scope has no Pages.
     */
    const bulkCandidates = Effect.fn("ParentsRepo.bulkCandidates", {
      level: "Debug",
    })(function* (scope: BulkScrape) {
      const l = listingBase(db)
      const p = pageBase(db)

      const listingScope = Match.value(scope).pipe(
        Match.tag("Brand", (scope) => eq(brands.id, scope.brandId)),
        Match.tag("Product", (scope) => eq(products.id, scope.productId)),
        Match.tag("Retailer", (scope) => eq(retailers.id, scope.retailerId)),
        Match.exhaustive,
      )

      const listingRows = yield* query(
        l.select
          .where(listingScope)
          .orderBy(asc(listings.createdAt), asc(listings.id)),
      )

      const pageRows = Predicate.isTagged(scope, "Product")
        ? []
        : yield* query(
            p.select
              .where(
                Predicate.isTagged(scope, "Brand")
                  ? eq(brands.id, scope.brandId)
                  : eq(retailers.id, scope.retailerId),
              )
              .orderBy(asc(pages.createdAt), asc(pages.id)),
          )

      return yield* decodeTargets([...listingRows, ...pageRows])
    })

    /** Whether the bulk scope's container row exists. */
    const containerExists = Effect.fn("ParentsRepo.containerExists", {
      level: "Debug",
    })(function* (scope: BulkScrape) {
      const rows = yield* Match.value(scope).pipe(
        Match.tag("Brand", (scope) =>
          query(
            db
              .select({ id: brands.id })
              .from(brands)
              .where(eq(brands.id, scope.brandId)),
          ),
        ),
        Match.tag("Product", (scope) =>
          query(
            db
              .select({ id: products.id })
              .from(products)
              .where(eq(products.id, scope.productId)),
          ),
        ),
        Match.tag("Retailer", (scope) =>
          query(
            db
              .select({ id: retailers.id })
              .from(retailers)
              .where(eq(retailers.id, scope.retailerId)),
          ),
        ),
        Match.exhaustive,
      )

      return rows.length > 0
    })

    /** Last scraped at advances only on fetch success (CONTEXT.md). */
    const markScraped = Effect.fn("ParentsRepo.markScraped", {
      level: "Debug",
    })(function* (parent: ScrapeParent, at: DateTime.Utc) {
      const lastScrapedAt = DateTime.toDateUtc(at)

      const table = Predicate.isTagged(parent, "Listing") ? listings : pages

      const id = Predicate.isTagged(parent, "Listing")
        ? parent.listingId
        : parent.pageId

      yield* query(
        db
          .update(table)
          .set({ lastScrapedAt, updatedAt: lastScrapedAt })
          .where(eq(table.id, id)),
      )
    })

    return {
      findTarget,
      cadenceDue,
      bulkCandidates,
      containerExists,
      markScraped,
      getTarget,
    } as const
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
