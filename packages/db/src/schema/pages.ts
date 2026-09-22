import {
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { at, id, timestamps } from "./columns"
import { cadenceEnum } from "./enums"
import { BrandsTable } from "./brands"
import { RetailersTable } from "./retailers"

export const PagesTable = pgTable(
  "pages",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => BrandsTable.id, { onDelete: "cascade" }),
    retailerId: uuid("retailer_id")
      .notNull()
      .references(() => RetailersTable.id, { onDelete: "cascade" }),
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
