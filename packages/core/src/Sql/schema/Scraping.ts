import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"
import { listings, pages, ScrapeMode } from "./Catalog.ts"
import {
  id,
  json,
  jsonCheck,
  literals,
  literalsCheck,
  nullableLiteralsCheck,
  timestamp,
  timestamps,
} from "./Columns.ts"

/**
 * Scrape and Extraction rows. The row is the source of truth for an
 * Execution's outcome; everything the lifecycle has not yet produced is NULL.
 *
 * A Scrape has exactly one Parent: the CHECK forces exactly one of
 * `listing_id` and `page_id` to be set, and both cascade. Parent kind is
 * derived from which one is set.
 *
 * No denormalised "latest" pointers: latest and latest-successful
 * Extractions are indexed queries over `(scrape_id, status, attempt)`.
 *
 * Stored HTML and the forensic provider response live in R2 under keys
 * derived from the Scrape id; the `*_r2_key` columns record that the object
 * was written.
 */

export const Status = ["pending", "running", "success", "failed"] as const
export const PromptKind = ["listing", "page"] as const
export const ScrapeErrorCode = [
  "timeout",
  "navigation_failed",
  "blocked",
  "provider_error",
  "invalid_url",
  "parent_deleted",
  "unknown",
] as const
export const ExtractionErrorCode = [
  "provider_error",
  "json_mode_unmet",
  "invalid_json",
  "llm_timeout",
  "context_overflow",
  "unknown",
] as const

export const scrapes = sqliteTable(
  "scrapes",
  {
    id: id(),
    listingId: text("listing_id").references(() => listings.id, {
      onDelete: "cascade",
    }),
    pageId: text("page_id").references(() => pages.id, { onDelete: "cascade" }),
    // Snapshot of the Retailer defaults or the manual override at dispatch.
    mode: literals("mode", ScrapeMode).notNull(),
    country: text("country"),
    status: literals("status", Status).notNull(),
    // The URL actually fetched; a later Parent URL change rewrites nothing.
    requestUrl: text("request_url").notNull(),
    requestHeaders: json("request_headers"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    errorCode: literals("error_code", ScrapeErrorCode),
    errorMessage: text("error_message"),
    htmlR2Key: text("html_r2_key"),
    rawR2Key: text("raw_r2_key"),
    // Scrape envelope (domain `ScrapeEnvelope`), NULL until success; gaps a
    // mode cannot fill stay NULL.
    finalUrl: text("final_url"),
    statusCode: integer("status_code"),
    responseHeaders: json("response_headers"),
    cookies: json("cookies"),
    innerText: text("inner_text"),
    userAgent: text("user_agent"),
    ipInfo: json("ip_info"),
    type: text("type"),
    session: text("session"),
    attempts: integer("attempts"),
    ...timestamps(),
  },
  (t) => [
    check(
      "scrapes_exactly_one_parent",
      sql`(${t.listingId} IS NULL) <> (${t.pageId} IS NULL)`,
    ),
    index("scrapes_status_created_at").on(t.status, t.createdAt),
    index("scrapes_listing_id_status_created_at").on(
      t.listingId,
      t.status,
      t.createdAt,
    ),
    index("scrapes_page_id_status_created_at").on(
      t.pageId,
      t.status,
      t.createdAt,
    ),
    index("scrapes_created_at").on(t.createdAt),
    literalsCheck("scrapes", t.mode, ScrapeMode),
    literalsCheck("scrapes", t.status, Status),
    nullableLiteralsCheck("scrapes", t.errorCode, ScrapeErrorCode),
    jsonCheck("scrapes", t.requestHeaders),
    jsonCheck("scrapes", t.responseHeaders),
    jsonCheck("scrapes", t.cookies),
    jsonCheck("scrapes", t.ipInfo),
  ],
)

export const extractions = sqliteTable(
  "extractions",
  {
    id: id(),
    scrapeId: text("scrape_id")
      .notNull()
      .references(() => scrapes.id, { onDelete: "cascade" }),
    // 1-based ordinal within the Scrape; the unique index makes assignment
    // race-safe without a counter column.
    attempt: integer("attempt").notNull(),
    status: literals("status", Status).notNull(),
    promptKind: literals("prompt_kind", PromptKind).notNull(),
    // The literal prompt text this Extraction ran with.
    promptSnapshot: text("prompt_snapshot").notNull(),
    // The model identifier actually used, so usage stays attributable.
    model: text("model").notNull(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    // Extracted JSON lives on the row (ADR 0007 of the previous app).
    extractedJson: json("extracted_json"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    totalTokens: integer("total_tokens"),
    errorCode: literals("error_code", ExtractionErrorCode),
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
    check("extractions_attempt_positive", sql`${t.attempt} >= 1`),
    literalsCheck("extractions", t.status, Status),
    literalsCheck("extractions", t.promptKind, PromptKind),
    nullableLiteralsCheck("extractions", t.errorCode, ExtractionErrorCode),
    jsonCheck("extractions", t.extractedJson),
  ],
)
