import { index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core"
import { at, id, timestamps } from "./columns"
import { cadenceEnum } from "./enums"
import { ProductsTable, ProductVariantsTable } from "./products"
import { RetailersTable } from "./retailers"

export const ListingsTable = pgTable(
  "listings",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => ProductsTable.id, { onDelete: "cascade" }),
    retailerId: uuid("retailer_id")
      .notNull()
      .references(() => RetailersTable.id, { onDelete: "cascade" }),
    // Current pointer; not unique, and changing it rewrites no history.
    url: text("url").notNull(),
    cadence: cadenceEnum("cadence").notNull(),
    // Advances only on fetch success. NULL until the first success.
    lastScrapedAt: at("last_scraped_at"),
    ...timestamps(),
  },
  (t) => [
    index("listings_product_id").on(t.productId),
    index("listings_retailer_id").on(t.retailerId),
    index("listings_last_scraped_at").on(t.lastScrapedAt),
  ],
)

export const ListingVariantsTable = pgTable(
  "listing_variants",
  {
    listingId: uuid("listing_id")
      .notNull()
      .references(() => ListingsTable.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => ProductVariantsTable.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.variantId] }),
    index("listing_variants_variant_id").on(t.variantId),
  ],
)
