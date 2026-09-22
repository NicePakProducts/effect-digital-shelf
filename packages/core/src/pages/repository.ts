import * as DateTime from "effect/DateTime"
import { Page } from "@app/schema/page"
import {
  combinedStatus,
  ScrapeStatus,
  ExtractionStatus,
} from "@app/schema/scraping-vocabulary"
import type { BrandId, PageId, RetailerId } from "@app/schema/ids"
import { nullable } from "@app/schema/refine"
import { BrandsTable } from "@app/db/schema/brands"
import { PagesTable } from "@app/db/schema/pages"
import { RetailersTable } from "@app/db/schema/retailers"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { ExtractionsTable } from "@app/db/schema/extractions"
import { and, asc, desc, eq, getTableColumns, sql } from "drizzle-orm"
import * as Data from "effect/Data"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { onUniqueViolation, query } from "../Sql/Errors"
import * as Rows from "../Sql/Rows"
/**
 * Page rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `MissingPage`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

export class PageTaken extends Data.TaggedError("PageTaken") {}

const one = Rows.decodeOptional(Page.Info)

const all = Rows.decodeAll(Page.Info)

const exactlyOne = Rows.decodeOne(Page.Info)

const toRow = Rows.encode(Page.Insert)

const toPatch = Rows.encode(Page.UpdateRow)

const orNotFound =
  (id: PageId) =>
  <R>(
    self: Effect.Effect<Option.Option<Page.Info>, SqlError, R>,
  ): Effect.Effect<Page.Info, MissingPage | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new MissingPage({ pageId: id })),
        onSome: Effect.succeed,
      }),
    )

export type Filter = { brandId?: BrandId; retailerId?: RetailerId }

const StatusRow = Schema.Struct({
  ...Page.Info.fields,
  effectivePaused: Schema.Boolean,
  scrapeStatus: nullable(ScrapeStatus),
  extractionStatus: nullable(ExtractionStatus),
})

const withStatus = (db: Db["Service"]) => {
  const last = db
    .select({ id: ScrapesTable.id, status: ScrapesTable.status })
    .from(ScrapesTable)
    .where(eq(ScrapesTable.pageId, PagesTable.id))
    .orderBy(desc(ScrapesTable.createdAt), desc(ScrapesTable.id))
    .limit(1)
    .as("last_scrape")

  const extraction = db
    .select({ status: ExtractionsTable.status })
    .from(ExtractionsTable)
    .where(eq(ExtractionsTable.scrapeId, last.id))
    .orderBy(desc(ExtractionsTable.attempt))
    .limit(1)
    .as("last_extraction")

  return db
    .select({
      ...getTableColumns(PagesTable),
      effectivePaused: sql<boolean>`(${BrandsTable.paused} OR ${RetailersTable.paused} OR ${PagesTable.paused})`,
      scrapeStatus: last.status,
      extractionStatus: extraction.status,
    })
    .from(PagesTable)
    .innerJoin(BrandsTable, eq(BrandsTable.id, PagesTable.brandId))
    .innerJoin(RetailersTable, eq(RetailersTable.id, PagesTable.retailerId))
    .leftJoinLateral(last, sql`true`)
    .leftJoinLateral(extraction, sql`true`)
}

export * as PagesRepo from "./repository"

export interface Interface {
  readonly markScraped: (
    id: PageId,
    at: DateTime.Utc,
  ) => Effect.Effect<void, SqlError>
  readonly find: (
    id: PageId,
  ) => Effect.Effect<Option.Option<Page.Info>, SqlError>
  readonly get: (id: PageId) => Effect.Effect<Page.Info, MissingPage | SqlError>
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Page.Info>, SqlError>
  readonly insert: (
    page: Page.Insert,
  ) => Effect.Effect<Page.Info, SqlError | PageTaken>
  readonly update: (
    id: PageId,
    patch: Page.UpdateRow,
  ) => Effect.Effect<Page.Info, MissingPage | SqlError>
  readonly remove: (
    id: PageId,
  ) => Effect.Effect<Page.Info, MissingPage | SqlError>
  readonly findByBrandAndRetailer: (
    brandId: BrandId,
    retailerId: RetailerId,
  ) => Effect.Effect<Option.Option<Page.Info>, SqlError>
  readonly findWithStatus: (
    id: PageId,
  ) => Effect.Effect<Option.Option<Page.WithStatus>, SqlError>
  readonly listWithStatus: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Page.WithStatus>, SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/pages/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const markScraped = (id: PageId, at: DateTime.Utc) =>
    query(
      db
        .update(PagesTable)
        .set({
          lastScrapedAt: DateTime.toDateUtc(at),
          updatedAt: DateTime.toDateUtc(at),
        })
        .where(eq(PagesTable.id, id)),
    ).pipe(Effect.asVoid)

  const find = Effect.fn("PagesRepo.find", { level: "Debug" })(function* (
    id: PageId,
  ) {
    return yield* one(
      yield* query(db.select().from(PagesTable).where(eq(PagesTable.id, id))),
    )
  })

  const get = (id: PageId) => find(id).pipe(orNotFound(id))

  const list = Effect.fn("PagesRepo.list", { level: "Debug" })(function* (
    filter: Filter = {},
  ) {
    return yield* all(
      yield* query(
        db
          .select()
          .from(PagesTable)
          .where(
            and(
              filter.brandId === undefined
                ? undefined
                : eq(PagesTable.brandId, filter.brandId),
              filter.retailerId === undefined
                ? undefined
                : eq(PagesTable.retailerId, filter.retailerId),
            ),
          )
          .orderBy(asc(PagesTable.createdAt), asc(PagesTable.id)),
      ),
    )
  })

  const insert = Effect.fn("PagesRepo.insert", { level: "Debug" })(function* (
    page: Page.Insert,
  ) {
    return yield* exactlyOne(
      yield* query(db.insert(PagesTable).values(toRow(page)).returning()).pipe(
        onUniqueViolation("pages_brand_id_retailer_id", () => new PageTaken()),
      ),
    )
  })

  const update = Effect.fn("PagesRepo.update", { level: "Debug" })(function* (
    id: PageId,
    patch: Page.UpdateRow,
  ) {
    const values = toPatch(patch)

    if (Object.keys(values).length === 0) return yield* get(id)

    return yield* one(
      yield* query(
        db
          .update(PagesTable)
          .set(values)
          .where(eq(PagesTable.id, id))
          .returning(),
      ),
    ).pipe(orNotFound(id))
  })

  /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
  const remove = Effect.fn("PagesRepo.remove", { level: "Debug" })(function* (
    id: PageId,
  ) {
    return yield* one(
      yield* query(
        db.delete(PagesTable).where(eq(PagesTable.id, id)).returning(),
      ),
    ).pipe(orNotFound(id))
  })

  const findByBrandAndRetailer = Effect.fn("PagesRepo.findByBrandAndRetailer", {
    level: "Debug",
  })(function* (brandId: BrandId, retailerId: RetailerId) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(PagesTable)
          .where(
            and(
              eq(PagesTable.brandId, brandId),
              eq(PagesTable.retailerId, retailerId),
            ),
          ),
      ),
    )
  })

  const readStatus = Effect.fn("PagesRepo.readStatus", { level: "Debug" })(
    function* (filter: Filter, id?: PageId) {
      const rows = yield* Rows.decodeAll(StatusRow)(
        yield* query(
          withStatus(db)
            .where(
              and(
                id === undefined ? undefined : eq(PagesTable.id, id),
                filter.brandId === undefined
                  ? undefined
                  : eq(PagesTable.brandId, filter.brandId),
                filter.retailerId === undefined
                  ? undefined
                  : eq(PagesTable.retailerId, filter.retailerId),
              ),
            )
            .orderBy(asc(PagesTable.createdAt), asc(PagesTable.id)),
        ),
      )

      return rows.map(({ scrapeStatus, extractionStatus, ...row }) => ({
        ...row,

        combinedStatus: combinedStatus(scrapeStatus, extractionStatus),
      }))
    },
  )

  const findWithStatus = Effect.fn("PagesRepo.findWithStatus", {
    level: "Debug",
  })(function* (id: PageId) {
    return Option.fromUndefinedOr((yield* readStatus({}, id))[0])
  })

  const listWithStatus = Effect.fn("PagesRepo.listWithStatus", {
    level: "Debug",
  })(function* (filter: Filter = {}) {
    return yield* readStatus(filter)
  })

  return {
    markScraped,
    find,
    get,
    list,
    insert,
    update,
    remove,
    findByBrandAndRetailer,
    findWithStatus,
    listWithStatus,
  } as const
})

export const layer = Layer.effect(Service, make)

export class MissingPage extends Data.TaggedError("MissingPage")<{
  readonly pageId: PageId
}> {}
