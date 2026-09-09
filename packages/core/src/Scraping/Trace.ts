import type { SpanId } from "@digital-shelf/domain/Scraping/Execution"
import type { ScrapeId } from "@digital-shelf/domain/Shared/Ids"

/**
 * Trace identity derives from the Scrape row (ADR 0007): the trace id is the
 * Scrape id without dashes, the root span id is stored on the row, and the
 * pair travels into a Workflow instance's params as a W3C `traceparent`.
 */

export const traceIdOf = (scrapeId: ScrapeId): string =>
  scrapeId.replaceAll("-", "").toLowerCase()

export const traceparentOf = (scrapeId: ScrapeId, rootSpanId: SpanId): string =>
  `00-${traceIdOf(scrapeId)}-${rootSpanId}-01`
