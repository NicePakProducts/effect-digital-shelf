import { Cadence, Cadences } from "@digital-shelf/domain/Catalog/Cadence"
import type { ScrapeParent } from "@digital-shelf/domain/Scraping/Scrape"
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
    onSome: (listingId) => ({ _tag: "Listing", listingId }) as const,
    onNone: () =>
      ({ _tag: "Page", pageId: Option.getOrThrow(target.pageId) }) as const,
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

export const findTarget = Effect.fn("ParentsRepo.findTarget")(function* (
  parent: ScrapeParent,
) {
  const db = yield* Db
  const rows =
    parent._tag === "Listing"
      ? yield* query(
          listingBase(db).select.where(eq(listings.id, parent.listingId)),
        )
      : yield* query(pageBase(db).select.where(eq(pages.id, parent.pageId)))
  const targets = yield* decodeTargets(rows)
  return Option.fromUndefinedOr(targets[0])
})

/**
 * Cadence-due Parents that are not effectively paused and not in flight,
 * never-scraped first, then oldest anchor first, at most `limit`. Two
 * queries (Listings, Pages) merged in memory: each is bounded by `limit`,
 * so the merge sees at most `2 * limit` rows.
 */
export const cadenceDue = Effect.fn("ParentsRepo.cadenceDue")(function* (
  now: DateTime.Utc,
  failureRetryInterval: Duration.Duration,
  limit: number,
) {
  if (limit <= 0) return []
  const db = yield* Db
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

/**
 * Every Parent under a bulk scope that is not effectively paused, cadence ignored.
 * In-flight candidates reach the insert so bulk can report them as skipped. A Product scope has no Pages.
 */
export const bulkCandidates = Effect.fn("ParentsRepo.bulkCandidates")(
  function* (scope: BulkScrape) {
    const db = yield* Db
    const l = listingBase(db)
    const p = pageBase(db)
    const listingScope =
      scope._tag === "Brand"
        ? eq(brands.id, scope.brandId)
        : scope._tag === "Product"
          ? eq(products.id, scope.productId)
          : eq(retailers.id, scope.retailerId)
    const listingRows = yield* query(
      l.select
        .where(
          and(
            listingScope,
            sql`NOT (${brands.paused} OR ${products.paused} OR ${retailers.paused})`,
          ),
        )
        .orderBy(asc(listings.createdAt), asc(listings.id)),
    )
    const pageRows =
      scope._tag === "Product"
        ? []
        : yield* query(
            p.select
              .where(
                and(
                  scope._tag === "Brand"
                    ? eq(brands.id, scope.brandId)
                    : eq(retailers.id, scope.retailerId),
                  sql`NOT (${brands.paused} OR ${retailers.paused} OR ${pages.paused})`,
                ),
              )
              .orderBy(asc(pages.createdAt), asc(pages.id)),
          )
    return yield* decodeTargets([...listingRows, ...pageRows])
  },
)

/** Whether the bulk scope's container row exists. */
export const containerExists = Effect.fn("ParentsRepo.containerExists")(
  function* (scope: BulkScrape) {
    const db = yield* Db
    const rows =
      scope._tag === "Brand"
        ? yield* query(
            db
              .select({ id: brands.id })
              .from(brands)
              .where(eq(brands.id, scope.brandId)),
          )
        : scope._tag === "Product"
          ? yield* query(
              db
                .select({ id: products.id })
                .from(products)
                .where(eq(products.id, scope.productId)),
            )
          : yield* query(
              db
                .select({ id: retailers.id })
                .from(retailers)
                .where(eq(retailers.id, scope.retailerId)),
            )
    return rows.length > 0
  },
)

/** Last scraped at advances only on fetch success (CONTEXT.md). */
export const markScraped = Effect.fn("ParentsRepo.markScraped")(function* (
  parent: ScrapeParent,
  at: DateTime.Utc,
) {
  const db = yield* Db
  const lastScrapedAt = DateTime.toDateUtc(at)
  if (parent._tag === "Listing") {
    yield* query(
      db
        .update(listings)
        .set({ lastScrapedAt, updatedAt: lastScrapedAt })
        .where(eq(listings.id, parent.listingId)),
    )
  } else {
    yield* query(
      db
        .update(pages)
        .set({ lastScrapedAt, updatedAt: lastScrapedAt })
        .where(eq(pages.id, parent.pageId)),
    )
  }
})
