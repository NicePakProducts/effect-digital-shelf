import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { ExtractionErrorCodes } from "@app/schema/scraping-vocabulary"
import { at, id, inFlight, nullableLiteralsCheck, timestamps } from "./columns"
import { extractionStatusEnum, promptKindEnum } from "./enums"
import { ScrapesTable } from "./scrapes"

export const ExtractionsTable = pgTable(
  "extractions",
  {
    id: id(),
    scrapeId: uuid("scrape_id")
      .notNull()
      .references(() => ScrapesTable.id, { onDelete: "cascade" }),
    // 1-based ordinal within the Scrape; the unique index makes assignment
    // race-safe without a counter column.
    attempt: integer("attempt").notNull(),
    status: extractionStatusEnum("status").notNull(),
    promptKind: promptKindEnum("prompt_kind").notNull(),
    // The literal prompt text this Extraction ran with.
    promptSnapshot: text("prompt_snapshot").notNull(),
    // The model identifier actually used, so usage stays attributable.
    model: text("model").notNull(),
    startedAt: at("started_at"),
    finishedAt: at("finished_at"),
    // Extracted JSON lives on the row (ADR 0007 of the previous app).
    extractedJson: jsonb("extracted_json"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("extractions_scrape_id_attempt").on(t.scrapeId, t.attempt),
    index("extractions_scrape_id_status_attempt").on(
      t.scrapeId,
      t.status,
      t.attempt,
    ),
    index("extractions_status_created_at").on(t.status, t.createdAt),
    index("extractions_prompt_kind_status").on(t.promptKind, t.status),
    // At most one Extraction in flight per Scrape (map ticket "Extraction
    // lifecycle"): a second re-extract is refused by this index, and the
    // `(scrape_id, attempt)` index above backstops attempt allocation.
    uniqueIndex("extractions_scrape_in_flight")
      .on(t.scrapeId)
      .where(inFlight(t)),
    check("extractions_attempt_positive", sql`${t.attempt} >= 1`),
    nullableLiteralsCheck("extractions", t.errorCode, ExtractionErrorCodes),
  ],
)
