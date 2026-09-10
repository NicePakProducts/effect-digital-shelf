import * as Schema from "effect/Schema"
import {
  BrandId,
  ListingId,
  PageId,
  ProductId,
  RetailerId,
  VariantId,
} from "../Shared/Ids.ts"

/**
 * Business-rule errors of the catalog, declared once. Core raises them; api
 * lists them per endpoint with an `httpApiStatus` annotation. Anything that
 * never crosses the wire (repository, provider failures) lives in core.
 */

export class BrandNotFound extends Schema.TaggedError<BrandNotFound>()(
  "BrandNotFound",
  { brandId: BrandId },
) {}

export class ProductNotFound extends Schema.TaggedError<ProductNotFound>()(
  "ProductNotFound",
  { productId: ProductId },
) {}

export class VariantNotFound extends Schema.TaggedError<VariantNotFound>()(
  "VariantNotFound",
  { variantId: VariantId },
) {}

export class RetailerNotFound extends Schema.TaggedError<RetailerNotFound>()(
  "RetailerNotFound",
  { retailerId: RetailerId },
) {}

export class ListingNotFound extends Schema.TaggedError<ListingNotFound>()(
  "ListingNotFound",
  { listingId: ListingId },
) {}

export class PageNotFound extends Schema.TaggedError<PageNotFound>()(
  "PageNotFound",
  { pageId: PageId },
) {}

/** Variant names are unique within a Product, ignoring case. */
export class DuplicateVariantName extends Schema.TaggedError<DuplicateVariantName>()(
  "DuplicateVariantName",
  { productId: ProductId, name: Schema.String },
) {}

/** Variant coverage may only name Variants of the Listing's Product. */
export class VariantNotInProduct extends Schema.TaggedError<VariantNotInProduct>()(
  "VariantNotInProduct",
  { variantId: VariantId, productId: ProductId },
) {}

/** The pasted value did not canonicalise to a host. */
export class InvalidRetailerDomain extends Schema.TaggedError<InvalidRetailerDomain>()(
  "InvalidRetailerDomain",
  { input: Schema.String },
) {}

/** A Retailer's canonical domain is unique globally. */
export class RetailerDomainTaken extends Schema.TaggedError<RetailerDomainTaken>()(
  "RetailerDomainTaken",
  { domain: Schema.String, retailerId: RetailerId },
) {}

/** A Page is unique per (Brand, Retailer). */
export class PageAlreadyExists extends Schema.TaggedError<PageAlreadyExists>()(
  "PageAlreadyExists",
  { brandId: BrandId, retailerId: RetailerId, pageId: PageId },
) {}

/**
 * A Listing or Page URL does not sit on its Retailer's domain. Raised on the
 * child write that would store it and on a Retailer domain change that would
 * invalidate children already stored; the Retailer path names the offending
 * rows, and `url` is the first URL that would violate the domain.
 */
export class UrlHostMismatch extends Schema.TaggedError<UrlHostMismatch>()(
  "UrlHostMismatch",
  {
    url: Schema.String,
    domain: Schema.String,
    listingIds: Schema.Array(ListingId),
    pageIds: Schema.Array(PageId),
  },
) {}
