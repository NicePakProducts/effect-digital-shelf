import { boolean, pgTable, text } from "drizzle-orm/pg-core"
import { id, timestamps } from "./columns"

export const BrandsTable = pgTable("brands", {
  id: id(),
  // Not unique: sub-brands are separate Brands and may share a name.
  name: text("name").notNull(),
  paused: boolean("paused").notNull().default(false),
  ...timestamps(),
})
