import {
  CreateListing,
  UpdateListing,
} from "@digital-shelf/domain/Catalog/ListingManagement"
import { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Errors from "./Errors.ts"
import * as Wire from "./ListingsWire.ts"

export class ListingsApi extends HttpApiGroup.make("listings").add(
  HttpApiEndpoint.get("list", "/listings", {
    query: Wire.ListingsQuery,
    success: Wire.ListingList,
  }),
  HttpApiEndpoint.get("get", "/listings/:id", {
    params: Wire.IdParams,
    success: Wire.ListingWire,
    error: [Errors.ListingNotFound],
  }),
  HttpApiEndpoint.post("create", "/listings", {
    payload: CreateListing,
    success: Wire.ListingWire.pipe(HttpApiSchema.status(201)),
    error: [
      Errors.ProductNotFound,
      Errors.RetailerNotFound,
      Errors.VariantNotInProduct,
    ],
  }),
  HttpApiEndpoint.patch("update", "/listings/:id", {
    params: Wire.IdParams,
    payload: UpdateListing,
    success: Wire.ListingWire,
    error: [Errors.ListingNotFound, Errors.VariantNotInProduct],
  }),
  HttpApiEndpoint.get("impact", "/listings/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.ListingNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/listings/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.ListingNotFound],
  }),
) {}
