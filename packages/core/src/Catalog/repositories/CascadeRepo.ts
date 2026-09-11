import * as Predicate from "effect/Predicate"
import {
  CascadeImpact,
  emptyImpact,
} from "@digital-shelf/domain/Catalog/CascadeImpact"
import {
  type BrandId,
  type ProductId,
  type VariantId,
  type RetailerId,
  type ListingId,
  type PageId,
  ScrapeId,
} from "@digital-shelf/domain/Shared/Ids"
import {
  products,
  variants,
  listings,
  pages,
} from "@digital-shelf/domain/Sql/Catalog"
import { scrapes } from "@digital-shelf/domain/Sql/Scraping"
import { eq, inArray, or, sql } from "drizzle-orm"
import * as Data from "effect/Data"
import * as Match from "effect/Match"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

export type CascadeRoot =
  | { _tag: "Brand"; id: BrandId }
  | { _tag: "Product"; id: ProductId }
  | { _tag: "Variant"; id: VariantId }
  | { _tag: "Retailer"; id: RetailerId }
  | { _tag: "Listing"; id: ListingId }
  | { _tag: "Page"; id: PageId }

export const CascadeRoot = Data.taggedEnum<CascadeRoot>()

/** SQL predicates mirror the foreign-key subtree; the root itself is never counted. */
const subtree = (db: Db["Service"], root: CascadeRoot) => {
  const product = Match.value(root).pipe(
    Match.tag("Brand", ({ id }) => eq(products.brandId, id)),
    Match.tag("Product", ({ id }) => eq(products.id, id)),
    Match.orElse(() => sql`false`),
  )

  const productIds = db
    .select({ id: products.id })
    .from(products)
    .where(product)

  const listing = Match.value(root).pipe(
    Match.tag("Brand", "Product", () =>
      inArray(listings.productId, productIds),
    ),
    Match.tag("Retailer", ({ id }) => eq(listings.retailerId, id)),
    Match.tag("Listing", ({ id }) => eq(listings.id, id)),
    Match.orElse(() => sql`false`),
  )

  const page = Match.value(root).pipe(
    Match.tag("Brand", ({ id }) => eq(pages.brandId, id)),
    Match.tag("Retailer", ({ id }) => eq(pages.retailerId, id)),
    Match.tag("Page", ({ id }) => eq(pages.id, id)),
    Match.orElse(() => sql`false`),
  )

  const scrape = or(
    inArray(
      scrapes.listingId,
      db.select({ id: listings.id }).from(listings).where(listing),
    ),
    inArray(
      scrapes.pageId,
      db.select({ id: pages.id }).from(pages).where(page),
    ),
  )

  return { product, productIds, listing, page, scrape }
}

export const impact = Effect.fn("CascadeRepo.impact", { level: "Debug" })(
  function* (root: CascadeRoot) {
    if (Predicate.isTagged(root, "Variant")) return emptyImpact
    const db = yield* Db
    const tree = subtree(db, root)

    return yield* Rows.decodeOne(CascadeImpact)(
      yield* query(
        db
          .select({
            products: Predicate.isTagged(root, "Brand")
              ? sql<number>`(select count(*)::int from ${products} where ${tree.product})`
              : sql<number>`0`,
            variants: sql<number>`(select count(*)::int from ${variants} where ${inArray(variants.productId, tree.productIds)})`,
            listings: Predicate.isTagged(root, "Listing")
              ? sql<number>`0`
              : sql<number>`(select count(*)::int from ${listings} where ${tree.listing})`,
            pages: Predicate.isTagged(root, "Page")
              ? sql<number>`0`
              : sql<number>`(select count(*)::int from ${pages} where ${tree.page})`,
            scrapes: sql<number>`(select count(*)::int from ${scrapes} where ${tree.scrape})`,
          })
          .from(sql`(values (1)) as cascade_root(n)`),
      ),
    )
  },
)

export const scrapeIds = Effect.fn("CascadeRepo.scrapeIds", { level: "Debug" })(
  function* (root: CascadeRoot) {
    if (Predicate.isTagged(root, "Variant")) return []
    const db = yield* Db

    const rows = yield* Rows.decodeAll(Schema.Struct({ id: ScrapeId }))(
      yield* query(
        db
          .select({ id: scrapes.id })
          .from(scrapes)
          .where(subtree(db, root).scrape),
      ),
    )

    return rows.map((row) => row.id)
  },
)
