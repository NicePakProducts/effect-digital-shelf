import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import { Cadence, Cadences } from "@app/schema/cadence"
import { Scrape } from "@app/schema/scrape"
import { ScrapeMode, ScrapeStatus } from "@app/schema/scraping-vocabulary"
import { ListingId, PageId, RetailerId } from "@app/schema/ids"
import { Timestamp, nullable } from "@app/schema/refine"
import { BrandsTable } from "@app/db/schema/brands"
import { ListingsTable } from "@app/db/schema/listings"
import { PagesTable } from "@app/db/schema/pages"
import { ProductsTable } from "@app/db/schema/products"
import { RetailersTable } from "@app/db/schema/retailers"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { and, asc, desc, eq, notExists, sql, type SQL } from "drizzle-orm"
import type { AnyPgColumn } from "drizzle-orm/pg-core"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { cadenceInterval } from "../../Sql/Cadence"
import { Db } from "@app/db"
import { query } from "../../Sql/Errors"
import * as Rows from "../../Sql/Rows"
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

export const parentOf = (target: ScrapeTarget): Scrape.Parent =>
  Option.match(target.listingId, {
    onSome: (listingId) => Scrape.Parent.members[0].make({ listingId }),
    onNone: () =>
      Scrape.Parent.members[1].make({
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
    .select({ createdAt: ScrapesTable.createdAt, status: ScrapesTable.status })
    .from(ScrapesTable)
    .where(eq(ScrapesTable.listingId, ListingsTable.id))
    .orderBy(desc(ScrapesTable.createdAt), desc(ScrapesTable.id))
    .limit(1)
    .as("last")

  const select = db
    .select({
      parentKind: sql<"listing">`'listing'`,
      listingId: ListingsTable.id,
      pageId: sql<null>`NULL::uuid`,
      retailerId: ListingsTable.retailerId,
      url: ListingsTable.url,
      cadence: ListingsTable.cadence,
      mode: RetailersTable.scrapeMode,
      country: RetailersTable.scrapeCountry,
      prompt: RetailersTable.listingExtractPrompt,
      paused: sql<boolean>`(${BrandsTable.paused} OR ${ProductsTable.paused} OR ${RetailersTable.paused})`,
      anchorAt: last.createdAt,
      anchorStatus: last.status,
    })
    .from(ListingsTable)
    .innerJoin(ProductsTable, eq(ProductsTable.id, ListingsTable.productId))
    .innerJoin(BrandsTable, eq(BrandsTable.id, ProductsTable.brandId))
    .innerJoin(RetailersTable, eq(RetailersTable.id, ListingsTable.retailerId))
    .leftJoinLateral(last, sql`true`)

  return { select, last }
}

const pageBase = (db: Db["Service"]) => {
  const last = db
    .select({ createdAt: ScrapesTable.createdAt, status: ScrapesTable.status })
    .from(ScrapesTable)
    .where(eq(ScrapesTable.pageId, PagesTable.id))
    .orderBy(desc(ScrapesTable.createdAt), desc(ScrapesTable.id))
    .limit(1)
    .as("last")

  const select = db
    .select({
      parentKind: sql<"page">`'page'`,
      listingId: sql<null>`NULL::uuid`,
      pageId: PagesTable.id,
      retailerId: PagesTable.retailerId,
      url: PagesTable.url,
      cadence: PagesTable.cadence,
      mode: RetailersTable.scrapeMode,
      country: RetailersTable.scrapeCountry,
      prompt: RetailersTable.pageExtractPrompt,
      paused: sql<boolean>`(${BrandsTable.paused} OR ${RetailersTable.paused} OR ${PagesTable.paused})`,
      anchorAt: last.createdAt,
      anchorStatus: last.status,
    })
    .from(PagesTable)
    .innerJoin(BrandsTable, eq(BrandsTable.id, PagesTable.brandId))
    .innerJoin(RetailersTable, eq(RetailersTable.id, PagesTable.retailerId))
    .leftJoinLateral(last, sql`true`)

  return { select, last }
}

const listingNotInFlight = notExists(
  sql`(SELECT 1 FROM ${ScrapesTable} WHERE ${ScrapesTable.listingId} = ${ListingsTable.id} AND ${ScrapesTable.status} IN ('pending', 'running'))`,
)

const pageNotInFlight = notExists(
  sql`(SELECT 1 FROM ${ScrapesTable} WHERE ${ScrapesTable.pageId} = ${PagesTable.id} AND ${ScrapesTable.status} IN ('pending', 'running'))`,
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

export * as ParentsRepo from "./repository"

export interface Interface {
  readonly findTarget: (
    parent: Scrape.Parent,
  ) => Effect.Effect<Option.Option<ScrapeTarget>, SqlError>
  readonly cadenceDue: (
    now: DateTime.Utc,
    failureRetryInterval: Duration.Duration,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ScrapeTarget>, SqlError>
  readonly bulkCandidates: (
    scope: Scrape.Bulk,
  ) => Effect.Effect<ReadonlyArray<ScrapeTarget>, SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/parents/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const findTarget = Effect.fn("ParentsRepo.findTarget", {
    level: "Debug",
  })(function* (parent: Scrape.Parent) {
    const rows = Predicate.isTagged(parent, "Listing")
      ? yield* query(
          listingBase(db).select.where(eq(ListingsTable.id, parent.listingId)),
        )
      : yield* query(
          pageBase(db).select.where(eq(PagesTable.id, parent.pageId)),
        )

    const targets = yield* decodeTargets(rows)

    return Option.fromUndefinedOr(targets[0])
  })

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
            sql`NOT (${BrandsTable.paused} OR ${ProductsTable.paused} OR ${RetailersTable.paused})`,
            listingNotInFlight,
            due(l.last, ListingsTable.cadence),
          ),
        )
        .orderBy(
          sql`${l.last.createdAt} ASC NULLS FIRST`,
          asc(ListingsTable.id),
        )
        .limit(limit),
    )

    const pageRows = yield* query(
      p.select
        .where(
          and(
            sql`NOT (${BrandsTable.paused} OR ${RetailersTable.paused} OR ${PagesTable.paused})`,
            pageNotInFlight,
            due(p.last, PagesTable.cadence),
          ),
        )
        .orderBy(sql`${p.last.createdAt} ASC NULLS FIRST`, asc(PagesTable.id))
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
  })(function* (scope: Scrape.Bulk) {
    const l = listingBase(db)
    const p = pageBase(db)

    const listingScope = Match.value(scope).pipe(
      Match.tag("Brand", (scope) => eq(BrandsTable.id, scope.brandId)),
      Match.tag("Product", (scope) => eq(ProductsTable.id, scope.productId)),
      Match.tag("Retailer", (scope) => eq(RetailersTable.id, scope.retailerId)),
      Match.exhaustive,
    )

    const listingRows = yield* query(
      l.select
        .where(listingScope)
        .orderBy(asc(ListingsTable.createdAt), asc(ListingsTable.id)),
    )

    const pageRows = Predicate.isTagged(scope, "Product")
      ? []
      : yield* query(
          p.select
            .where(
              Predicate.isTagged(scope, "Brand")
                ? eq(BrandsTable.id, scope.brandId)
                : eq(RetailersTable.id, scope.retailerId),
            )
            .orderBy(asc(PagesTable.createdAt), asc(PagesTable.id)),
        )

    return yield* decodeTargets([...listingRows, ...pageRows])
  })

  return {
    findTarget,
    cadenceDue,
    bulkCandidates,
  } as const
})

export const layer = Layer.effect(Service, make)
