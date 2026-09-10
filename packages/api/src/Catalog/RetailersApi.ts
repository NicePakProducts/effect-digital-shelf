import {
  CreateRetailer,
  UpdateRetailer,
} from "@digital-shelf/domain/Catalog/RetailerManagement"
import { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Errors from "./Errors.ts"
import * as Wire from "./RetailersWire.ts"

export class RetailersApi extends HttpApiGroup.make("retailers").add(
  HttpApiEndpoint.get("list", "/retailers", { success: Wire.RetailerList }),
  HttpApiEndpoint.get("get", "/retailers/:id", {
    params: Wire.IdParams,
    success: Wire.RetailerWire,
    error: [Errors.RetailerNotFound],
  }),
  HttpApiEndpoint.post("create", "/retailers", {
    payload: CreateRetailer,
    success: Wire.RetailerWire.pipe(HttpApiSchema.status(201)),
    error: [Errors.InvalidRetailerDomain, Errors.RetailerDomainTaken],
  }),
  HttpApiEndpoint.patch("update", "/retailers/:id", {
    params: Wire.IdParams,
    payload: UpdateRetailer,
    success: Wire.RetailerWire,
    error: [
      Errors.RetailerNotFound,
      Errors.InvalidRetailerDomain,
      Errors.RetailerDomainTaken,
      Errors.UrlHostMismatch,
    ],
  }),
  HttpApiEndpoint.get("impact", "/retailers/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.RetailerNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/retailers/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.RetailerNotFound],
  }),
) {}
