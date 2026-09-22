import * as Schema from "effect/Schema"
import { ListingId, VariantId, ProductId } from "@app/schema/ids"
import { RetailerNotFound, UrlHostMismatch } from "./retailers"
import { ProductNotFound } from "./products"
import { Listing } from "@app/schema/listing"
import { CascadeImpact } from "@app/schema/cascade"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./listing-wire"

export class ListingNotFound extends Schema.TaggedError<ListingNotFound>()(
  "ListingNotFound",
  { listingId: ListingId },
  { httpApiStatus: 404 },
) {}

export class VariantNotInProduct extends Schema.TaggedError<VariantNotInProduct>()(
  "VariantNotInProduct",
  { variantId: VariantId, productId: ProductId },
  { httpApiStatus: 422 },
) {}

export class ListingsApi extends HttpApiGroup.make("listings").add(
  HttpApiEndpoint.get("list", "/listings", {
    query: Wire.ListingsQuery,
    success: Wire.ListingList,
  }),
  HttpApiEndpoint.get("get", "/listings/:id", {
    params: Wire.IdParams,
    success: Wire.ListingWire,
    error: [ListingNotFound],
  }),
  HttpApiEndpoint.post("create", "/listings", {
    payload: Listing.Create,
    success: Wire.ListingWire.pipe(HttpApiSchema.status(201)),
    error: [
      ProductNotFound,
      RetailerNotFound,
      VariantNotInProduct,
      UrlHostMismatch,
    ],
  }),
  HttpApiEndpoint.patch("update", "/listings/:id", {
    params: Wire.IdParams,
    payload: Listing.Update,
    success: Wire.ListingWire,
    error: [ListingNotFound, VariantNotInProduct, UrlHostMismatch],
  }),
  HttpApiEndpoint.get("impact", "/listings/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [ListingNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/listings/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [ListingNotFound],
  }),
) {}
