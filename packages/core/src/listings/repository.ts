import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import { Listing } from "@app/schema/listing"
import {
  combinedStatus,
  ScrapeStatus,
  ExtractionStatus,
} from "@app/schema/scraping-vocabulary"
import {
  VariantId,
  type ListingId,
  type ProductId,
  type RetailerId,
} from "@app/schema/ids"
import { nullable } from "@app/schema/refine"
import { BrandsTable } from "@app/db/schema/brands"
import { ListingsTable, ListingVariantsTable } from "@app/db/schema/listings"
import { ProductsTable, ProductVariantsTable } from "@app/db/schema/products"
import { RetailersTable } from "@app/db/schema/retailers"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { ExtractionsTable } from "@app/db/schema/extractions"
import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { query } from "../Sql/Errors"
import * as Rows from "../Sql/Rows"
/**
 * Listing rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `MissingListing`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(Listing.Info)

const all = Rows.decodeAll(Listing.Info)

const exactlyOne = Rows.decodeOne(Listing.Info)

const toRow = Rows.encode(Listing.Insert)

const toPatch = Rows.encode(Listing.UpdateRow)

const orNotFound =
  (id: ListingId) =>
  <R>(
    self: Effect.Effect<Option.Option<Listing.Info>, SqlError, R>,
  ): Effect.Effect<Listing.Info, MissingListing | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new MissingListing({ listingId: id })),
        onSome: Effect.succeed,
      }),
    )

export type Filter = { productId?: ProductId; retailerId?: RetailerId }

const StatusRow = Schema.Struct({
  ...Listing.Info.fields,
  effectivePaused: Schema.Boolean,
  scrapeStatus: nullable(ScrapeStatus),
  extractionStatus: nullable(ExtractionStatus),
})

const withStatus = (db: Db["Service"]) => {
  const last = db
    .select({ id: ScrapesTable.id, status: ScrapesTable.status })
    .from(ScrapesTable)
    .where(eq(ScrapesTable.listingId, ListingsTable.id))
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
      ...getTableColumns(ListingsTable),
      effectivePaused: sql<boolean>`(${BrandsTable.paused} OR ${RetailersTable.paused} OR ${ProductsTable.paused})`,
      scrapeStatus: last.status,
      extractionStatus: extraction.status,
    })
    .from(ListingsTable)
    .innerJoin(ProductsTable, eq(ProductsTable.id, ListingsTable.productId))
    .innerJoin(BrandsTable, eq(BrandsTable.id, ProductsTable.brandId))
    .innerJoin(RetailersTable, eq(RetailersTable.id, ListingsTable.retailerId))
    .leftJoinLateral(last, sql`true`)
    .leftJoinLateral(extraction, sql`true`)
}

export * as ListingsRepo from "./repository"

export interface Interface {
  readonly markScraped: (
    id: ListingId,
    at: DateTime.Utc,
  ) => Effect.Effect<void, SqlError>
  readonly find: (
    id: ListingId,
  ) => Effect.Effect<Option.Option<Listing.Info>, SqlError>
  readonly get: (
    id: ListingId,
  ) => Effect.Effect<Listing.Info, MissingListing | SqlError>
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Listing.Info>, SqlError>
  readonly insert: (
    listing: Listing.Insert,
  ) => Effect.Effect<Listing.Info, SqlError>
  readonly update: (
    id: ListingId,
    patch: Listing.UpdateRow,
  ) => Effect.Effect<Listing.Info, MissingListing | SqlError>
  readonly remove: (
    id: ListingId,
  ) => Effect.Effect<Listing.Info, MissingListing | SqlError>
  readonly coverageOf: (
    id: ListingId,
  ) => Effect.Effect<ReadonlyArray<VariantId>, SqlError>
  readonly replaceCoverage: (
    listingId: ListingId,
    variantIds: ReadonlyArray<VariantId>,
  ) => Effect.Effect<void, SqlError>
  readonly findWithStatus: (
    id: ListingId,
  ) => Effect.Effect<Option.Option<Listing.WithStatus>, SqlError>
  readonly listWithStatus: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Listing.WithStatus>, SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/listings/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const markScraped = (id: ListingId, at: DateTime.Utc) =>
    query(
      db
        .update(ListingsTable)
        .set({
          lastScrapedAt: DateTime.toDateUtc(at),
          updatedAt: DateTime.toDateUtc(at),
        })
        .where(eq(ListingsTable.id, id)),
    ).pipe(Effect.asVoid)

  const find = Effect.fn("ListingsRepo.find", { level: "Debug" })(function* (
    id: ListingId,
  ) {
    return yield* one(
      yield* query(
        db.select().from(ListingsTable).where(eq(ListingsTable.id, id)),
      ),
    )
  })

  const get = (id: ListingId) => find(id).pipe(orNotFound(id))

  const list = Effect.fn("ListingsRepo.list", { level: "Debug" })(function* (
    filter: Filter = {},
  ) {
    return yield* all(
      yield* query(
        db
          .select()
          .from(ListingsTable)
          .where(
            and(
              filter.productId === undefined
                ? undefined
                : eq(ListingsTable.productId, filter.productId),
              filter.retailerId === undefined
                ? undefined
                : eq(ListingsTable.retailerId, filter.retailerId),
            ),
          )
          .orderBy(asc(ListingsTable.createdAt), asc(ListingsTable.id)),
      ),
    )
  })

  const insert = Effect.fn("ListingsRepo.insert", { level: "Debug" })(
    function* (listing: Listing.Insert) {
      return yield* exactlyOne(
        yield* query(
          db.insert(ListingsTable).values(toRow(listing)).returning(),
        ),
      )
    },
  )

  const update = Effect.fn("ListingsRepo.update", { level: "Debug" })(
    function* (id: ListingId, patch: Listing.UpdateRow) {
      const values = toPatch(patch)

      if (Object.keys(values).length === 0) return yield* get(id)

      return yield* one(
        yield* query(
          db
            .update(ListingsTable)
            .set(values)
            .where(eq(ListingsTable.id, id))
            .returning(),
        ),
      ).pipe(orNotFound(id))
    },
  )

  /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
  const remove = Effect.fn("ListingsRepo.remove", { level: "Debug" })(
    function* (id: ListingId) {
      return yield* one(
        yield* query(
          db.delete(ListingsTable).where(eq(ListingsTable.id, id)).returning(),
        ),
      ).pipe(orNotFound(id))
    },
  )

  const coverage = Effect.fn("ListingsRepo.coverage", { level: "Debug" })(
    function* (ids: ReadonlyArray<ListingId>) {
      if (ids.length === 0) return []

      return yield* Rows.decodeAll(Listing.Variant)(
        yield* query(
          db
            .select({
              listingId: ListingVariantsTable.listingId,
              variantId: ListingVariantsTable.variantId,
            })
            .from(ListingVariantsTable)
            .innerJoin(
              ProductVariantsTable,
              eq(ProductVariantsTable.id, ListingVariantsTable.variantId),
            )
            .where(inArray(ListingVariantsTable.listingId, ids))
            .orderBy(
              asc(ProductVariantsTable.name),
              asc(ProductVariantsTable.createdAt),
              asc(ProductVariantsTable.id),
            ),
        ),
      )
    },
  )

  const coverageOf = Effect.fn("ListingsRepo.coverageOf", {
    level: "Debug",
  })(function* (id: ListingId) {
    return (yield* coverage([id])).map((row) => row.variantId)
  })

  const replaceCoverage = Effect.fn("ListingsRepo.replaceCoverage", {
    level: "Debug",
  })(function* (listingId: ListingId, variantIds: ReadonlyArray<VariantId>) {
    yield* query(
      db
        .delete(ListingVariantsTable)
        .where(eq(ListingVariantsTable.listingId, listingId)),
    )
    const ids = [...new Set(variantIds)]

    if (ids.length > 0)
      yield* query(
        db
          .insert(ListingVariantsTable)
          .values(ids.map((variantId) => ({ listingId, variantId }))),
      )
  })

  const readStatus = Effect.fn("ListingsRepo.readStatus", { level: "Debug" })(
    function* (filter: Filter, id?: ListingId) {
      const rows = yield* Rows.decodeAll(StatusRow)(
        yield* query(
          withStatus(db)
            .where(
              and(
                id === undefined ? undefined : eq(ListingsTable.id, id),
                filter.productId === undefined
                  ? undefined
                  : eq(ListingsTable.productId, filter.productId),
                filter.retailerId === undefined
                  ? undefined
                  : eq(ListingsTable.retailerId, filter.retailerId),
              ),
            )
            .orderBy(asc(ListingsTable.createdAt), asc(ListingsTable.id)),
        ),
      )

      const edges = yield* coverage(rows.map((row) => row.id))

      return rows.map(({ scrapeStatus, extractionStatus, ...row }) => ({
        ...row,
        variantIds: edges
          .filter((edge) => edge.listingId === row.id)
          .map((edge) => edge.variantId),
        combinedStatus: combinedStatus(scrapeStatus, extractionStatus),
      }))
    },
  )

  const findWithStatus = Effect.fn("ListingsRepo.findWithStatus", {
    level: "Debug",
  })(function* (id: ListingId) {
    return Option.fromUndefinedOr((yield* readStatus({}, id))[0])
  })

  const listWithStatus = Effect.fn("ListingsRepo.listWithStatus", {
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
    coverageOf,
    replaceCoverage,
    findWithStatus,
    listWithStatus,
  } as const
})

export const layer = Layer.effect(Service, make)

export class MissingListing extends Data.TaggedError("MissingListing")<{
  readonly listingId: ListingId
}> {}
