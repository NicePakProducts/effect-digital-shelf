import { ListingNotFound } from "@digital-shelf/domain/Catalog/Errors"
import {
  Listing,
  ListingInsert,
  ListingUpdate,
  ListingVariant,
} from "@digital-shelf/domain/Catalog/Listing"
import {
  combinedStatus,
  ScrapeStatus,
  ExtractionStatus,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import {
  VariantId,
  type ListingId,
  type ProductId,
  type RetailerId,
} from "@digital-shelf/domain/Shared/Ids"
import { nullable } from "@digital-shelf/domain/Shared/Refine"
import {
  brands,
  listingVariants,
  listings,
  products,
  retailers,
  variants,
} from "@digital-shelf/domain/Sql/Catalog"
import { scrapes, extractions } from "@digital-shelf/domain/Sql/Scraping"
import { and, asc, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Listing rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `ListingNotFound`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

const one = Rows.decodeOptional(Listing)

const all = Rows.decodeAll(Listing)

const exactlyOne = Rows.decodeOne(Listing)

const toRow = Rows.encode(ListingInsert)

const toPatch = Rows.encode(ListingUpdate)

const orNotFound =
  (id: ListingId) =>
  <R>(
    self: Effect.Effect<Option.Option<Listing>, SqlError, R>,
  ): Effect.Effect<Listing, ListingNotFound | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new ListingNotFound({ listingId: id })),
        onSome: Effect.succeed,
      }),
    )

export const find = Effect.fn("ListingsRepo.find", { level: "Debug" })(
  function* (id: ListingId) {
    const db = yield* Db

    return yield* one(
      yield* query(db.select().from(listings).where(eq(listings.id, id))),
    )
  },
)

export const get = (id: ListingId) => find(id).pipe(orNotFound(id))

export type Filter = { productId?: ProductId; retailerId?: RetailerId }

export const list = Effect.fn("ListingsRepo.list", { level: "Debug" })(
  function* (filter: Filter = {}) {
    const db = yield* Db

    return yield* all(
      yield* query(
        db
          .select()
          .from(listings)
          .where(
            and(
              filter.productId === undefined
                ? undefined
                : eq(listings.productId, filter.productId),
              filter.retailerId === undefined
                ? undefined
                : eq(listings.retailerId, filter.retailerId),
            ),
          )
          .orderBy(asc(listings.createdAt), asc(listings.id)),
      ),
    )
  },
)

export const insert = Effect.fn("ListingsRepo.insert", { level: "Debug" })(
  function* (listing: ListingInsert) {
    const db = yield* Db

    return yield* exactlyOne(
      yield* query(db.insert(listings).values(toRow(listing)).returning()),
    )
  },
)

export const update = Effect.fn("ListingsRepo.update", { level: "Debug" })(
  function* (id: ListingId, patch: ListingUpdate) {
    const values = toPatch(patch)

    if (Object.keys(values).length === 0) return yield* get(id)
    const db = yield* Db

    return yield* one(
      yield* query(
        db.update(listings).set(values).where(eq(listings.id, id)).returning(),
      ),
    ).pipe(orNotFound(id))
  },
)

/** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
export const remove = Effect.fn("ListingsRepo.remove", { level: "Debug" })(
  function* (id: ListingId) {
    const db = yield* Db

    return yield* one(
      yield* query(db.delete(listings).where(eq(listings.id, id)).returning()),
    ).pipe(orNotFound(id))
  },
)

const coverage = Effect.fn("ListingsRepo.coverage", { level: "Debug" })(
  function* (ids: ReadonlyArray<ListingId>) {
    if (ids.length === 0) return []
    const db = yield* Db

    return yield* Rows.decodeAll(ListingVariant)(
      yield* query(
        db
          .select({
            listingId: listingVariants.listingId,
            variantId: listingVariants.variantId,
          })
          .from(listingVariants)
          .innerJoin(variants, eq(variants.id, listingVariants.variantId))
          .where(inArray(listingVariants.listingId, ids))
          .orderBy(
            asc(variants.name),
            asc(variants.createdAt),
            asc(variants.id),
          ),
      ),
    )
  },
)

export const coverageOf = Effect.fn("ListingsRepo.coverageOf", {
  level: "Debug",
})(function* (id: ListingId) {
  return (yield* coverage([id])).map((row) => row.variantId)
})

export const replaceCoverage = Effect.fn("ListingsRepo.replaceCoverage", {
  level: "Debug",
})(function* (listingId: ListingId, variantIds: ReadonlyArray<VariantId>) {
  const db = yield* Db
  yield* query(
    db.delete(listingVariants).where(eq(listingVariants.listingId, listingId)),
  )
  const ids = [...new Set(variantIds)]

  if (ids.length > 0)
    yield* query(
      db
        .insert(listingVariants)
        .values(ids.map((variantId) => ({ listingId, variantId }))),
    )
})

export const variantsNotInProduct = Effect.fn(
  "ListingsRepo.variantsNotInProduct",
  { level: "Debug" },
)(function* (productId: ProductId, variantIds: ReadonlyArray<VariantId>) {
  if (variantIds.length === 0) return []
  const db = yield* Db

  const rows = yield* Rows.decodeAll(Schema.Struct({ id: VariantId }))(
    yield* query(
      db
        .select({ id: variants.id })
        .from(variants)
        .where(
          and(
            eq(variants.productId, productId),
            inArray(variants.id, variantIds),
          ),
        ),
    ),
  )

  const valid = new Set(rows.map((row) => row.id))

  return variantIds.filter((id) => !valid.has(id))
})

const StatusRow = Schema.Struct({
  ...Listing.fields,
  effectivePaused: Schema.Boolean,
  scrapeStatus: nullable(ScrapeStatus),
  extractionStatus: nullable(ExtractionStatus),
})

const withStatus = (db: Db["Service"]) => {
  const last = db
    .select({ id: scrapes.id, status: scrapes.status })
    .from(scrapes)
    .where(eq(scrapes.listingId, listings.id))
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
      ...getTableColumns(listings),
      effectivePaused: sql<boolean>`(${brands.paused} OR ${retailers.paused} OR ${products.paused})`,
      scrapeStatus: last.status,
      extractionStatus: extraction.status,
    })
    .from(listings)
    .innerJoin(products, eq(products.id, listings.productId))
    .innerJoin(brands, eq(brands.id, products.brandId))
    .innerJoin(retailers, eq(retailers.id, listings.retailerId))
    .leftJoinLateral(last, sql`true`)
    .leftJoinLateral(extraction, sql`true`)
}

const readStatus = Effect.fn("ListingsRepo.readStatus", { level: "Debug" })(
  function* (filter: Filter, id?: ListingId) {
    const db = yield* Db

    const rows = yield* Rows.decodeAll(StatusRow)(
      yield* query(
        withStatus(db)
          .where(
            and(
              id === undefined ? undefined : eq(listings.id, id),
              filter.productId === undefined
                ? undefined
                : eq(listings.productId, filter.productId),
              filter.retailerId === undefined
                ? undefined
                : eq(listings.retailerId, filter.retailerId),
            ),
          )
          .orderBy(asc(listings.createdAt), asc(listings.id)),
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

export const findWithStatus = Effect.fn("ListingsRepo.findWithStatus", {
  level: "Debug",
})(function* (id: ListingId) {
  return Option.fromUndefinedOr((yield* readStatus({}, id))[0])
})

export const listWithStatus = Effect.fn("ListingsRepo.listWithStatus", {
  level: "Debug",
})(function* (filter: Filter = {}) {
  return yield* readStatus(filter)
})
