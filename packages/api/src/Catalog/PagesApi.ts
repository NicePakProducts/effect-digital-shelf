import {
  CreatePage,
  UpdatePage,
} from "@digital-shelf/domain/Catalog/PageManagement"
import { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Errors from "./Errors.ts"
import * as Wire from "./PagesWire.ts"

export class PagesApi extends HttpApiGroup.make("pages").add(
  HttpApiEndpoint.get("list", "/pages", {
    query: Wire.PagesQuery,
    success: Wire.PageList,
  }),
  HttpApiEndpoint.get("get", "/pages/:id", {
    params: Wire.IdParams,
    success: Wire.PageWire,
    error: [Errors.PageNotFound],
  }),
  HttpApiEndpoint.post("create", "/pages", {
    payload: CreatePage,
    success: Wire.PageWire.pipe(HttpApiSchema.status(201)),
    error: [
      Errors.BrandNotFound,
      Errors.RetailerNotFound,
      Errors.PageAlreadyExists,
    ],
  }),
  HttpApiEndpoint.patch("update", "/pages/:id", {
    params: Wire.IdParams,
    payload: UpdatePage,
    success: Wire.PageWire,
    error: [Errors.PageNotFound],
  }),
  HttpApiEndpoint.get("impact", "/pages/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.PageNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/pages/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.PageNotFound],
  }),
) {}
