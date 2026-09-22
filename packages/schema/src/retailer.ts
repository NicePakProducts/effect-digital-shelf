import * as Schema from "effect/Schema"
import { ScrapeMode } from "./scraping-vocabulary"
import { RetailerId } from "./ids"
import { Timestamp, Name } from "./refine"

export * as Retailer from "./retailer"

/**
 * A canonical host: lower-case, no scheme, path, port or leading `www.`, and
 * at least one dot. Core derives it from whatever the user pasted
 * (`RetailerManagement.CreateRetailer.domain`); this is the stored form.
 */
export const Domain = Schema.String.check(
  Schema.isPattern(/^(?!www\.)[a-z0-9-]+(\.[a-z0-9-]+)+$/, {
    identifier: "RetailerDomain",
    description: "a canonical host such as chemistwarehouse.com.au",
  }),
).pipe(Schema.brand("RetailerDomain"))

export type Domain = typeof Domain.Type

/**
 * Whether a URL sits on a Retailer's domain: hosts are compared lower-cased
 * and with a leading `www.` stripped from either side, and a subdomain passes
 * only on a dot boundary, so `shop.bigw.com.au` matches `bigw.com.au` while
 * the lookalike `evilbigw.com.au` does not. A URL the parser rejects never
 * matches; commands carry a parsed `Url` already.
 */
export const hostMatches = (url: string, domain: string): boolean => {
  if (!URL.canParse(url)) return false
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  const target = domain.toLowerCase().replace(/^www\./, "")

  return host === target || host.endsWith(`.${target}`)
}

/** A destination domain we scrape, global and shared across all Brands. */
export const Info = Schema.Struct({
  id: RetailerId,
  name: Schema.String,
  domain: Domain,
  paused: Schema.Boolean,
  scrapeMode: ScrapeMode,
  scrapeCountry: Schema.String,
  listingExtractPrompt: Schema.String,
  pageExtractPrompt: Schema.String,
  createdAt: Timestamp,
  updatedAt: Timestamp,
})

export type Info = typeof Info.Type

export const Insert = Schema.Struct({
  id: Schema.optionalKey(RetailerId),
  name: Schema.String,
  domain: Domain,
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  scrapeMode: ScrapeMode,
  scrapeCountry: Schema.String,
  listingExtractPrompt: Schema.String,
  pageExtractPrompt: Schema.String,
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type Insert = typeof Insert.Type

export const UpdateRow = Schema.Struct({
  id: Schema.optionalKey(RetailerId),
  name: Schema.optional(Schema.UndefinedOr(Schema.String)),
  domain: Schema.optionalKey(Domain),
  paused: Schema.optional(Schema.UndefinedOr(Schema.Boolean)),
  scrapeMode: Schema.optional(Schema.UndefinedOr(ScrapeMode)),
  scrapeCountry: Schema.optional(Schema.UndefinedOr(Schema.String)),
  listingExtractPrompt: Schema.optional(Schema.UndefinedOr(Schema.String)),
  pageExtractPrompt: Schema.optional(Schema.UndefinedOr(Schema.String)),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
})

export type UpdateRow = typeof UpdateRow.Type

/**
 * `domain` is whatever the user pasted: a bare host or a full URL. Core
 * canonicalises it to a `RetailerDomain` or fails with InvalidRetailerDomain.
 * Scrape defaults and both prompts are seeded when omitted.
 */
export const Create = Schema.Struct({
  name: Name,
  domain: Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)),
  paused: Schema.optionalKey(Schema.Boolean),
  scrapeMode: Schema.optionalKey(ScrapeMode),
  scrapeCountry: Schema.optionalKey(Schema.NonEmptyString),
  listingExtractPrompt: Schema.optionalKey(Schema.NonEmptyString),
  pageExtractPrompt: Schema.optionalKey(Schema.NonEmptyString),
})

export type Create = typeof Create.Type

export const Update = Schema.Struct({
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

export type Update = typeof Update.Type

/** Seeded on Retailer creation when omitted (Extraction prompt); freely edited afterwards, never versioned. */
export const defaultScrapeMode: ScrapeMode = "basic"

export const defaultScrapeCountry = "Australia"

export const defaultListingExtractPrompt =
  "Extract this retailer product listing as JSON: name, brand, price, currency, availability, promotions, rating, review count, images and the variants offered."

export const defaultPageExtractPrompt =
  "Extract this retailer brand page as JSON: page title, products listed (name, price, currency, availability), promotions and banners."

export const GetInput = Schema.Struct({ retailerId: RetailerId })

export type GetInput = typeof GetInput.Type

export const GetForShareInput = Schema.Struct({
  retailerId: RetailerId,
})

export type GetForShareInput = typeof GetForShareInput.Type

export const RemoveInput = Schema.Struct({ retailerId: RetailerId })

export type RemoveInput = typeof RemoveInput.Type

export const ImpactInput = Schema.Struct({ retailerId: RetailerId })

export type ImpactInput = typeof ImpactInput.Type

export const UpdateInput = Schema.Struct({
  retailerId: RetailerId,
  command: Update,
})

export type UpdateInput = typeof UpdateInput.Type

export const Id = RetailerId

export type Id = typeof Id.Type
