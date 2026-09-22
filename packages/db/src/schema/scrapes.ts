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
import { ScrapeErrorCodes } from "@app/schema/scraping-vocabulary"
import { at, id, inFlight, nullableLiteralsCheck, timestamps } from "./columns"
import { scrapeModeEnum, scrapeStatusEnum } from "./enums"
import { ListingsTable } from "./listings"
import { PagesTable } from "./pages"

export const ScrapesTable = pgTable(
  "scrapes",
  {
    id: id(),
    listingId: uuid("listing_id").references(() => ListingsTable.id, {
      onDelete: "cascade",
    }),
    pageId: uuid("page_id").references(() => PagesTable.id, {
      onDelete: "cascade",
    }),
    // Snapshot of the Retailer defaults or the manual override at dispatch.
    mode: scrapeModeEnum("mode").notNull(),
    country: text("country"),
    status: scrapeStatusEnum("status").notNull(),
    // Span id of the `Scrape.created` root span; the trace id is the Scrape
    // id without dashes (ADR 0007).
    rootSpanId: text("root_span_id").notNull(),
    // The URL actually fetched; a later Parent URL change rewrites nothing.
    requestUrl: text("request_url").notNull(),
    requestHeaders: jsonb("request_headers"),
    startedAt: at("started_at"),
    finishedAt: at("finished_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    htmlR2Key: text("html_r2_key"),
    rawR2Key: text("raw_r2_key"),
    // Scrape envelope (domain `ScrapeEnvelope`), NULL until success; gaps a
    // mode cannot fill stay NULL.
    finalUrl: text("final_url"),
    statusCode: integer("status_code"),
    responseHeaders: jsonb("response_headers"),
    cookies: jsonb("cookies"),
    innerText: text("inner_text"),
    userAgent: text("user_agent"),
    ipInfo: jsonb("ip_info"),
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
    uniqueIndex("scrapes_listing_in_flight").on(t.listingId).where(inFlight(t)),
    uniqueIndex("scrapes_page_in_flight").on(t.pageId).where(inFlight(t)),
    check("scrapes_root_span_id_hex", sql`${t.rootSpanId} ~ '^[0-9a-f]{16}$'`),
    nullableLiteralsCheck("scrapes", t.errorCode, ScrapeErrorCodes),
  ],
)
