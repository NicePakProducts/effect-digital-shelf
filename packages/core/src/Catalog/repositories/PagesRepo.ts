import { PageNotFound } from "@digital-shelf/domain/Catalog/Errors"
import {
  Page,
  PageInsert,
  PageUpdate,
} from "@digital-shelf/domain/Catalog/Page"
import {
  combinedStatus,
  ScrapeStatus,
  ExtractionStatus,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import {
  type BrandId,
  type PageId,
  type RetailerId,
} from "@digital-shelf/domain/Shared/Ids"
import { nullable } from "@digital-shelf/domain/Shared/Refine"
import { brands, pages, retailers } from "@digital-shelf/domain/Sql/Catalog"
import { scrapes, extractions } from "@digital-shelf/domain/Sql/Scraping"
import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { onUniqueViolation, query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Page rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `PageNotFound`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

export class PageTaken extends Data.TaggedError("PageTaken") {}

const one = Rows.decodeOptional(Page)
const all = Rows.decodeAll(Page)
const exactlyOne = Rows.decodeOne(Page)
const toRow = Rows.encode(PageInsert)
const toPatch = Rows.encode(PageUpdate)

const orNotFound =
  (id: PageId) =>
  <R>(
    self: Effect.Effect<Option.Option<Page>, SqlError, R>,
  ): Effect.Effect<Page, PageNotFound | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new PageNotFound({ pageId: id })),
        onSome: Effect.succeed,
      }),
    )

export const find = Effect.fn("PagesRepo.find")(function* (id: PageId) {
  const db = yield* Db
  return yield* one(
    yield* query(db.select().from(pages).where(eq(pages.id, id))),
  )
})

export const get = (id: PageId) => find(id).pipe(orNotFound(id))

export type Filter = { brandId?: BrandId; retailerId?: RetailerId }
export const list = Effect.fn("PagesRepo.list")(function* (
  filter: Filter = {},
) {
  const db = yield* Db
  return yield* all(
    yield* query(
      db
        .select()
        .from(pages)
        .where(
          and(
            filter.brandId === undefined
              ? undefined
              : eq(pages.brandId, filter.brandId),
            filter.retailerId === undefined
              ? undefined
              : eq(pages.retailerId, filter.retailerId),
          ),
        )
        .orderBy(asc(pages.createdAt), asc(pages.id)),
    ),
  )
})

export const insert = Effect.fn("PagesRepo.insert")(function* (
  page: PageInsert,
) {
  const db = yield* Db
  return yield* exactlyOne(
    yield* query(db.insert(pages).values(toRow(page)).returning()).pipe(
      onUniqueViolation("pages_brand_id_retailer_id", () => new PageTaken()),
    ),
  )
})

export const update = Effect.fn("PagesRepo.update")(function* (
  id: PageId,
  patch: PageUpdate,
) {
  const values = toPatch(patch)
  if (Object.keys(values).length === 0) return yield* get(id)
  const db = yield* Db
  return yield* one(
    yield* query(
      db.update(pages).set(values).where(eq(pages.id, id)).returning(),
    ),
  ).pipe(orNotFound(id))
})

/** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
export const remove = Effect.fn("PagesRepo.remove")(function* (id: PageId) {
  const db = yield* Db
  return yield* one(
    yield* query(db.delete(pages).where(eq(pages.id, id)).returning()),
  ).pipe(orNotFound(id))
})

export const findByBrandAndRetailer = Effect.fn(
  "PagesRepo.findByBrandAndRetailer",
)(function* (brandId: BrandId, retailerId: RetailerId) {
  const db = yield* Db
  return yield* one(
    yield* query(
      db
        .select()
        .from(pages)
        .where(
          and(eq(pages.brandId, brandId), eq(pages.retailerId, retailerId)),
        ),
    ),
  )
})

const StatusRow = Schema.Struct({
  ...Page.fields,
  effectivePaused: Schema.Boolean,
  scrapeStatus: nullable(ScrapeStatus),
  extractionStatus: nullable(ExtractionStatus),
})
const withStatus = (db: Db["Service"]) => {
  const last = db
    .select({ id: scrapes.id, status: scrapes.status })
    .from(scrapes)
    .where(eq(scrapes.pageId, pages.id))
    .orderBy(desc(scrapes.createdAt), desc(scrapes.id))
    .limit(1)
    .as("last_scrape")
  const extraction = db
    .select({ status: extractions.status })
    .from(extractions)
    .where(eq(extractions.scrapeId, last.id))
    .orderBy(desc(extractions.attempt))
    .limit(1)
    .as("last_extraction")
  return db
    .select({
      ...getTableColumns(pages),
      effectivePaused: sql<boolean>`(${brands.paused} OR ${retailers.paused} OR ${pages.paused})`,
      scrapeStatus: last.status,
      extractionStatus: extraction.status,
    })
    .from(pages)
    .innerJoin(brands, eq(brands.id, pages.brandId))
    .innerJoin(retailers, eq(retailers.id, pages.retailerId))
    .leftJoinLateral(last, sql`true`)
    .leftJoinLateral(extraction, sql`true`)
}
const readStatus = Effect.fn("PagesRepo.readStatus")(function* (
  filter: Filter,
  id?: PageId,
) {
  const db = yield* Db
  const rows = yield* Rows.decodeAll(StatusRow)(
    yield* query(
      withStatus(db)
        .where(
          and(
            id === undefined ? undefined : eq(pages.id, id),
            filter.brandId === undefined
              ? undefined
              : eq(pages.brandId, filter.brandId),
            filter.retailerId === undefined
              ? undefined
              : eq(pages.retailerId, filter.retailerId),
          ),
        )
        .orderBy(asc(pages.createdAt), asc(pages.id)),
    ),
  )

  return rows.map(({ scrapeStatus, extractionStatus, ...row }) => ({
    ...row,

    combinedStatus: combinedStatus(scrapeStatus, extractionStatus),
  }))
})
export const findWithStatus = Effect.fn("PagesRepo.findWithStatus")(function* (
  id: PageId,
) {
  return Option.fromUndefinedOr((yield* readStatus({}, id))[0])
})
export const listWithStatus = Effect.fn("PagesRepo.listWithStatus")(function* (
  filter: Filter = {},
) {
  return yield* readStatus(filter)
})
