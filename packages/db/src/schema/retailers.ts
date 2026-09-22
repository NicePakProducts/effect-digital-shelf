import { boolean, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core"
import { id, timestamps } from "./columns"
import { scrapeModeEnum } from "./enums"

export const RetailersTable = pgTable(
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
