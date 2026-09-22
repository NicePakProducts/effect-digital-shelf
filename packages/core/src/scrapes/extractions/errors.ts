export * as ExtractionsErrors from "./errors"

import * as Data from "effect/Data"
import type { ExtractionId, ScrapeId } from "@app/schema/ids"
import type { PromptKind } from "@app/schema/scraping-vocabulary"
import type { Scrape } from "@app/schema/scrape"

export class NotFound extends Data.TaggedError("ExtractionNotFound")<{
  readonly extractionId: ExtractionId
}> {}

export class ScrapeNotReExtractable extends Data.TaggedError(
  "ScrapeNotReExtractable",
)<{
  readonly scrapeId: ScrapeId
  readonly reason: "not_successful" | "html_expired"
}> {}

export class InFlight extends Data.TaggedError("ExtractionInFlight")<{
  readonly scrapeId: ScrapeId
  readonly promptKind: PromptKind
  readonly extractionId: ExtractionId
}> {}

export class NoSuccessfulScrape extends Data.TaggedError("NoSuccessfulScrape")<{
  readonly parent: Scrape.Parent
}> {}
