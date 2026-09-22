import * as Schema from "effect/Schema"
import { RetailerId, ListingId, PageId } from "@app/schema/ids"
import { Retailer } from "@app/schema/retailer"
import { CascadeImpact } from "@app/schema/cascade"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./retailer-wire"

export class RetailerNotFound extends Schema.TaggedError<RetailerNotFound>()(
  "RetailerNotFound",
  { retailerId: RetailerId },
  { httpApiStatus: 404 },
) {}

export class InvalidRetailerDomain extends Schema.TaggedError<InvalidRetailerDomain>()(
  "InvalidRetailerDomain",
  { input: Schema.String },
  { httpApiStatus: 422 },
) {}

export class RetailerDomainTaken extends Schema.TaggedError<RetailerDomainTaken>()(
  "RetailerDomainTaken",
  { domain: Schema.String, retailerId: RetailerId },
  { httpApiStatus: 409 },
) {}

export class UrlHostMismatch extends Schema.TaggedError<UrlHostMismatch>()(
  "UrlHostMismatch",
  {
    url: Schema.String,
    domain: Schema.String,
    listingIds: Schema.Array(ListingId),
    pageIds: Schema.Array(PageId),
  },
  { httpApiStatus: 422 },
) {}

export class RetailersApi extends HttpApiGroup.make("retailers").add(
  HttpApiEndpoint.get("list", "/retailers", { success: Wire.RetailerList }),
  HttpApiEndpoint.get("get", "/retailers/:id", {
    params: Wire.IdParams,
    success: Wire.RetailerWire,
    error: [RetailerNotFound],
  }),
  HttpApiEndpoint.post("create", "/retailers", {
    payload: Retailer.Create,
    success: Wire.RetailerWire.pipe(HttpApiSchema.status(201)),
    error: [InvalidRetailerDomain, RetailerDomainTaken],
  }),
  HttpApiEndpoint.patch("update", "/retailers/:id", {
    params: Wire.IdParams,
    payload: Retailer.Update,
    success: Wire.RetailerWire,
    error: [
      RetailerNotFound,
      InvalidRetailerDomain,
      RetailerDomainTaken,
      UrlHostMismatch,
    ],
  }),
  HttpApiEndpoint.get("impact", "/retailers/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [RetailerNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/retailers/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [RetailerNotFound],
  }),
) {}
