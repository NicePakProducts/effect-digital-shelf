import {
  index,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import {
  boolean,
  booleanCheck,
  id,
  literals,
  literalsCheck,
  nocase,
  timestamp,
  timestamps,
} from "./Columns.ts"

/**
 * Catalog tables: Brand, Product, Variant, Retailer, Listing, Page and the
 * Variant coverage edge. See CONTEXT.md for the vocabulary and invariants.
 *
 * Every container -> child foreign key cascades (ADR 0001). The coverage
 * edge is its own table so deleting a Variant removes only edge rows and the
 * Listing survives with whatever coverage remains.
 *
 * Union literals are provisional lower-case spellings until the domain
 * package settles them; the migration is regenerated if they change.
 */

export const Cadence = ["daily", "weekly", "fortnightly", "monthly"] as const
export const ScrapeMode = ["basic", "advance"] as const

export const brands = sqliteTable(
  "brands",
  {
    id: id(),
    // Not unique: sub-brands are separate Brands and may share a name.
    name: text("name").notNull(),
    paused: boolean("paused"),
    ...timestamps(),
  },
  (t) => [booleanCheck("brands", t.paused)],
)

export const products = sqliteTable(
  "products",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    paused: boolean("paused"),
    ...timestamps(),
  },
  (t) => [
    index("products_brand_id").on(t.brandId),
    booleanCheck("products", t.paused),
  ],
)

export const variants = sqliteTable(
  "variants",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    // Trimmed by core; unique within the Product ignoring case, stored as
    // typed by the user.
    name: text("name").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("variants_product_id_name").on(t.productId, nocase(t.name)),
  ],
)

export const retailers = sqliteTable(
  "retailers",
  {
    id: id(),
    name: text("name").notNull(),
    // Canonical host: lower-case, no scheme, path, port or leading `www.`.
    // Core normalises before write.
    domain: text("domain").notNull(),
    paused: boolean("paused"),
    // Scrape defaults, snapshotted onto each Scrape at dispatch.
    scrapeMode: literals("scrape_mode", ScrapeMode).notNull(),
    scrapeCountry: text("scrape_country").notNull(),
    // One Extraction prompt per Parent kind, seeded on create.
    listingExtractPrompt: text("listing_extract_prompt").notNull(),
    pageExtractPrompt: text("page_extract_prompt").notNull(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("retailers_domain").on(t.domain),
    booleanCheck("retailers", t.paused),
    literalsCheck("retailers", t.scrapeMode, ScrapeMode),
  ],
)

export const listings = sqliteTable(
  "listings",
  {
    id: id(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    retailerId: text("retailer_id")
      .notNull()
      .references(() => retailers.id, { onDelete: "cascade" }),
    // Current pointer; not unique, and changing it rewrites no history.
    url: text("url").notNull(),
    cadence: literals("cadence", Cadence).notNull(),
    // Advances only on fetch success. NULL until the first success.
    lastScrapedAt: timestamp("last_scraped_at"),
    ...timestamps(),
  },
  (t) => [
    index("listings_product_id").on(t.productId),
    index("listings_retailer_id").on(t.retailerId),
    index("listings_last_scraped_at").on(t.lastScrapedAt),
    literalsCheck("listings", t.cadence, Cadence),
  ],
)

export const listingVariants = sqliteTable(
  "listing_variants",
  {
    listingId: text("listing_id")
      .notNull()
      .references(() => listings.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.variantId] }),
    index("listing_variants_variant_id").on(t.variantId),
  ],
)

export const pages = sqliteTable(
  "pages",
  {
    id: id(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    retailerId: text("retailer_id")
      .notNull()
      .references(() => retailers.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    cadence: literals("cadence", Cadence).notNull(),
    // The only child with its own pause toggle.
    paused: boolean("paused"),
    lastScrapedAt: timestamp("last_scraped_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("pages_brand_id_retailer_id").on(t.brandId, t.retailerId),
    index("pages_retailer_id").on(t.retailerId),
    index("pages_last_scraped_at").on(t.lastScrapedAt),
    booleanCheck("pages", t.paused),
    literalsCheck("pages", t.cadence, Cadence),
  ],
)
