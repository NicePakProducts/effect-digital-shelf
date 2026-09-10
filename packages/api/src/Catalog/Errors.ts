import * as Domain from "@digital-shelf/domain/Catalog/Errors"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"

/** Domain errors retain their identity; only their HTTP status is added here. */
export const BrandNotFound = Domain.BrandNotFound.pipe(
  HttpApiSchema.status(404),
)
export const ProductNotFound = Domain.ProductNotFound.pipe(
  HttpApiSchema.status(404),
)
export const VariantNotFound = Domain.VariantNotFound.pipe(
  HttpApiSchema.status(404),
)
export const RetailerNotFound = Domain.RetailerNotFound.pipe(
  HttpApiSchema.status(404),
)
export const ListingNotFound = Domain.ListingNotFound.pipe(
  HttpApiSchema.status(404),
)
export const PageNotFound = Domain.PageNotFound.pipe(HttpApiSchema.status(404))
export const RetailerDomainTaken = Domain.RetailerDomainTaken.pipe(
  HttpApiSchema.status(409),
)
export const DuplicateVariantName = Domain.DuplicateVariantName.pipe(
  HttpApiSchema.status(409),
)
export const PageAlreadyExists = Domain.PageAlreadyExists.pipe(
  HttpApiSchema.status(409),
)
export const InvalidRetailerDomain = Domain.InvalidRetailerDomain.pipe(
  HttpApiSchema.status(422),
)
export const VariantNotInProduct = Domain.VariantNotInProduct.pipe(
  HttpApiSchema.status(422),
)
export const UrlHostMismatch = Domain.UrlHostMismatch.pipe(
  HttpApiSchema.status(422),
)
