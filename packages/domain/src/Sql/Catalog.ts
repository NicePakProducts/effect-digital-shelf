import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { at, id, timestamps } from "./Columns.ts"
import { cadenceEnum, scrapeModeEnum } from "./Enums.ts"

/**
 * Catalog tables: Brand, Product, Variant, Retailer, Listing, Page and the
 * Variant coverage edge. See CONTEXT.md for the vocabulary and invariants.
 *
 * Every container -> child foreign key cascades (ADR 0001). The coverage
 * edge is its own table so deleting a Variant removes only edge rows and the
 * Listing survives with whatever coverage remains.
 */

export const brands = pgTable("brands", {
  id: id(),
  // Not unique: sub-brands are separate Brands and may share a name.
  name: text("name").notNull(),
  paused: boolean("paused").notNull().default(false),
  ...timestamps(),
})

export const products = pgTable(
  "products",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    paused: boolean("paused").notNull().default(false),
    ...timestamps(),
  },
  (t) => [index("products_brand_id").on(t.brandId)],
)

export const variants = pgTable(
  "variants",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    // Trimmed by core; unique within the Product ignoring case, stored as
    // typed by the user.
    name: text("name").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("variants_product_id_name").on(
      t.productId,
      sql`lower(${t.name})`,
    ),
  ],
)

export const retailers = pgTable(
  "retailers",
  {
    id: id(),
    name: text("name").notNull(),
    // Canonical host: lower-case, no scheme, path, port or leading `www.`.
    // Core normalises before write.
    domain: text("domain").notNull(),
    paused: boolean("paused").notNull().default(false),
    // Scrape defaults, snapshotted onto each Scrape at dispatch.
    scrapeMode: scrapeModeEnum("scrape_mode").notNull(),
    scrapeCountry: text("scrape_country").notNull(),
    // One Extraction prompt per Parent kind, seeded on create.
    listingExtractPrompt: text("listing_extract_prompt").notNull(),
    pageExtractPrompt: text("page_extract_prompt").notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex("retailers_domain").on(t.domain)],
)

export const listings = pgTable(
  "listings",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    retailerId: uuid("retailer_id")
      .notNull()
      .references(() => retailers.id, { onDelete: "cascade" }),
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

export const listingVariants = pgTable(
  "listing_variants",
  {
    listingId: uuid("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.variantId] }),
    index("listing_variants_variant_id").on(t.variantId),
  ],
)

export const pages = pgTable(
  "pages",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    retailerId: uuid("retailer_id")
      .notNull()
      .references(() => retailers.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    cadence: cadenceEnum("cadence").notNull(),
    // The only child with its own pause toggle.
    paused: boolean("paused").notNull().default(false),
    lastScrapedAt: at("last_scraped_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pages_brand_id_retailer_id").on(t.brandId, t.retailerId),
    index("pages_retailer_id").on(t.retailerId),
    index("pages_last_scraped_at").on(t.lastScrapedAt),
  ],
)
