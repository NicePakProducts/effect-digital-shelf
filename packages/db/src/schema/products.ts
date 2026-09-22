import { sql } from "drizzle-orm"
import {
  boolean,
  index,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { id, timestamps } from "./columns"
import { BrandsTable } from "./brands"

export const ProductsTable = pgTable(
  "products",
  {
    id: id(),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => BrandsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    paused: boolean("paused").notNull().default(false),
    ...timestamps(),
  },
  (t) => [index("products_brand_id").on(t.brandId)],
)

export const ProductVariantsTable = pgTable(
  "variants",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => ProductsTable.id, { onDelete: "cascade" }),
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
