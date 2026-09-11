import * as Domain from "@digital-shelf/domain/Scraping/Errors"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"

/** Domain errors retain their identity; only their HTTP status is added here. */
export const ScrapeNotFound = Domain.ScrapeNotFound.pipe(
  HttpApiSchema.status(404),
)

export const ExtractionNotFound = Domain.ExtractionNotFound.pipe(
  HttpApiSchema.status(404),
)

export const NoSuccessfulScrape = Domain.NoSuccessfulScrape.pipe(
  HttpApiSchema.status(404),
)

export const NoExtractedData = Domain.NoExtractedData.pipe(
  HttpApiSchema.status(404),
)

export const ParentInFlight = Domain.ParentInFlight.pipe(
  HttpApiSchema.status(409),
)

export const ExtractionInFlight = Domain.ExtractionInFlight.pipe(
  HttpApiSchema.status(409),
)

export const ScrapeNotReExtractable = Domain.ScrapeNotReExtractable.pipe(
  HttpApiSchema.status(422),
)
