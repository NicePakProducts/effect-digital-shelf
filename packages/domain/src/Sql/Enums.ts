import { pgEnum } from "drizzle-orm/pg-core"
import { Cadences } from "../Catalog/Cadence.ts"
import {
  LifecycleStatuses,
  ParentKinds,
  ScrapeModes,
} from "../Scraping/Vocabulary.ts"

/**
 * Postgres enums for the stable literal sets. The tuples live with the
 * vocabulary; these only give them a storage type. Adding a value is one
 * `ALTER TYPE ... ADD VALUE`; removing one means recreating the type, which is
 * why the error-code sets are text + CHECK instead.
 */
export const cadenceEnum = pgEnum("cadence", Cadences)

export const scrapeModeEnum = pgEnum("scrape_mode", ScrapeModes)

export const scrapeStatusEnum = pgEnum("scrape_status", LifecycleStatuses)

export const extractionStatusEnum = pgEnum(
  "extraction_status",
  LifecycleStatuses,
)

export const promptKindEnum = pgEnum("prompt_kind", ParentKinds)
