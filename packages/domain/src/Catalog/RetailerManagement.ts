import * as Schema from "effect/Schema"
import { ScrapeMode } from "../Scraping/Vocabulary.ts"
import { Name } from "../Shared/Refine.ts"

/**
 * `domain` is whatever the user pasted: a bare host or a full URL. Core
 * canonicalises it to a `RetailerDomain` or fails with InvalidRetailerDomain.
 * Scrape defaults and both prompts are seeded when omitted.
 */
export const CreateRetailer = Schema.Struct({
  name: Name,
  domain: Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)),
  paused: Schema.optionalKey(Schema.Boolean),
  scrapeMode: Schema.optionalKey(ScrapeMode),
  scrapeCountry: Schema.optionalKey(Schema.NonEmptyString),
  listingExtractPrompt: Schema.optionalKey(Schema.NonEmptyString),
  pageExtractPrompt: Schema.optionalKey(Schema.NonEmptyString),
})
export type CreateRetailer = typeof CreateRetailer.Type

export const UpdateRetailer = Schema.Struct({
  name: Schema.optionalKey(Name),
  domain: Schema.optionalKey(
    Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)),
  ),
  paused: Schema.optionalKey(Schema.Boolean),
  scrapeMode: Schema.optionalKey(ScrapeMode),
  scrapeCountry: Schema.optionalKey(Schema.NonEmptyString),
  listingExtractPrompt: Schema.optionalKey(Schema.NonEmptyString),
  pageExtractPrompt: Schema.optionalKey(Schema.NonEmptyString),
})
export type UpdateRetailer = typeof UpdateRetailer.Type

/** Seeded on Retailer creation when omitted (Extraction prompt); freely edited afterwards, never versioned. */
export const defaultScrapeMode: ScrapeMode = "basic"
export const defaultScrapeCountry = "Australia"
export const defaultListingExtractPrompt =
  "Extract this retailer product listing as JSON: name, brand, price, currency, availability, promotions, rating, review count, images and the variants offered."
export const defaultPageExtractPrompt =
  "Extract this retailer brand page as JSON: page title, products listed (name, price, currency, availability), promotions and banners."
