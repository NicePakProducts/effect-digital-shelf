import * as Schema from "effect/Schema"
import { ExtractionId, ScrapeId } from "../Shared/Ids.ts"
import { ScrapeParent } from "./Scrape.ts"
import { PromptKind } from "./Vocabulary.ts"

/** Business-rule errors of the scraping lifecycles; see Catalog/Errors.ts. */

export class ScrapeNotFound extends Schema.TaggedError<ScrapeNotFound>()(
  "ScrapeNotFound",
  { scrapeId: ScrapeId },
) {}

export class ExtractionNotFound extends Schema.TaggedError<ExtractionNotFound>()(
  "ExtractionNotFound",
  { extractionId: ExtractionId },
) {}

/** The Parent already has a Scrape in `pending` or `running`. */
export class ParentInFlight extends Schema.TaggedError<ParentInFlight>()(
  "ParentInFlight",
  { parent: ScrapeParent, scrapeId: ScrapeId },
) {}

/** Only a `success` Scrape whose HTML is still retained can be re-extracted. */
export class ScrapeNotReExtractable extends Schema.TaggedError<ScrapeNotReExtractable>()(
  "ScrapeNotReExtractable",
  {
    scrapeId: ScrapeId,
    reason: Schema.Literals(["not_successful", "html_expired"]),
  },
) {}

/** The Scrape already has an Extraction `pending` or `running` for this kind. */
export class ExtractionInFlight extends Schema.TaggedError<ExtractionInFlight>()(
  "ExtractionInFlight",
  { scrapeId: ScrapeId, promptKind: PromptKind, extractionId: ExtractionId },
) {}

export class NoSuccessfulScrape extends Schema.TaggedError<NoSuccessfulScrape>()(
  "NoSuccessfulScrape",
  { parent: ScrapeParent },
) {}
