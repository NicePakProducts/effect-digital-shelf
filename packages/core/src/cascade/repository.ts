import { CascadeRoot, CascadeImpact, emptyImpact } from "@app/schema/cascade"
import * as Predicate from "effect/Predicate"
import { ScrapeId } from "@app/schema/ids"
import { ProductsTable, ProductVariantsTable } from "@app/db/schema/products"
import { ListingsTable } from "@app/db/schema/listings"
import { PagesTable } from "@app/db/schema/pages"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { eq, inArray, or, sql } from "drizzle-orm"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Match from "effect/Match"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Db } from "@app/db"
import { query } from "../Sql/Errors"
import * as Rows from "../Sql/Rows"

/** SQL predicates mirror the foreign-key subtree; the root itself is never counted. */
const subtree = (db: Db["Service"], root: CascadeRoot) => {
  const product = Match.value(root).pipe(
    Match.tag("Brand", ({ id }) => eq(ProductsTable.brandId, id)),
    Match.tag("Product", ({ id }) => eq(ProductsTable.id, id)),
    Match.orElse(() => sql`false`),
  )

  const productIds = db
    .select({ id: ProductsTable.id })
    .from(ProductsTable)
    .where(product)

  const listing = Match.value(root).pipe(
    Match.tag("Brand", "Product", () =>
      inArray(ListingsTable.productId, productIds),
    ),
    Match.tag("Retailer", ({ id }) => eq(ListingsTable.retailerId, id)),
    Match.tag("Listing", ({ id }) => eq(ListingsTable.id, id)),
    Match.orElse(() => sql`false`),
  )

  const page = Match.value(root).pipe(
    Match.tag("Brand", ({ id }) => eq(PagesTable.brandId, id)),
    Match.tag("Retailer", ({ id }) => eq(PagesTable.retailerId, id)),
    Match.tag("Page", ({ id }) => eq(PagesTable.id, id)),
    Match.orElse(() => sql`false`),
  )

  const scrape = or(
    inArray(
      ScrapesTable.listingId,
      db.select({ id: ListingsTable.id }).from(ListingsTable).where(listing),
    ),
    inArray(
      ScrapesTable.pageId,
      db.select({ id: PagesTable.id }).from(PagesTable).where(page),
    ),
  )

  return { product, productIds, listing, page, scrape }
}

export * as CascadeRepo from "./repository"

export interface Interface {
  readonly impact: (root: CascadeRoot) => Effect.Effect<CascadeImpact, SqlError>
  readonly scrapeIds: (
    root: CascadeRoot,
  ) => Effect.Effect<ReadonlyArray<ScrapeId>, SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/cascade/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const impact = Effect.fn("CascadeRepo.impact", { level: "Debug" })(function* (
    root: CascadeRoot,
  ) {
    if (Predicate.isTagged(root, "Variant")) return emptyImpact
    const tree = subtree(db, root)

    return yield* Rows.decodeOne(CascadeImpact)(
      yield* query(
        db
          .select({
            products: Predicate.isTagged(root, "Brand")
              ? sql<number>`(select count(*)::int from ${ProductsTable} where ${tree.product})`
              : sql<number>`0`,
            variants: sql<number>`(select count(*)::int from ${ProductVariantsTable} where ${inArray(ProductVariantsTable.productId, tree.productIds)})`,
            listings: Predicate.isTagged(root, "Listing")
              ? sql<number>`0`
              : sql<number>`(select count(*)::int from ${ListingsTable} where ${tree.listing})`,
            pages: Predicate.isTagged(root, "Page")
              ? sql<number>`0`
              : sql<number>`(select count(*)::int from ${PagesTable} where ${tree.page})`,
            scrapes: sql<number>`(select count(*)::int from ${ScrapesTable} where ${tree.scrape})`,
          })
          .from(sql`(values (1)) as cascade_root(n)`),
      ),
    )
  })

  const scrapeIds = Effect.fn("CascadeRepo.scrapeIds", { level: "Debug" })(
    function* (root: CascadeRoot) {
      if (Predicate.isTagged(root, "Variant")) return []

      const rows = yield* Rows.decodeAll(Schema.Struct({ id: ScrapeId }))(
        yield* query(
          db
            .select({ id: ScrapesTable.id })
            .from(ScrapesTable)
            .where(subtree(db, root).scrape),
        ),
      )

      return rows.map((row) => row.id)
    },
  )

  return { impact, scrapeIds } as const
})

export const layer = Layer.effect(Service, make)
