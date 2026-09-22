import * as Schema from "effect/Schema"
import { PageId, BrandId, RetailerId } from "@app/schema/ids"
import { BrandNotFound } from "./brands"
import { RetailerNotFound, UrlHostMismatch } from "./retailers"
import { Page } from "@app/schema/page"
import { CascadeImpact } from "@app/schema/cascade"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./page-wire"

export class PageNotFound extends Schema.TaggedError<PageNotFound>()(
  "PageNotFound",
  { pageId: PageId },
  { httpApiStatus: 404 },
) {}

export class PageAlreadyExists extends Schema.TaggedError<PageAlreadyExists>()(
  "PageAlreadyExists",
  { brandId: BrandId, retailerId: RetailerId, pageId: PageId },
  { httpApiStatus: 409 },
) {}

export class PagesApi extends HttpApiGroup.make("pages").add(
  HttpApiEndpoint.get("list", "/pages", {
    query: Wire.PagesQuery,
    success: Wire.PageList,
  }),
  HttpApiEndpoint.get("get", "/pages/:id", {
    params: Wire.IdParams,
    success: Wire.PageWire,
    error: [PageNotFound],
  }),
  HttpApiEndpoint.post("create", "/pages", {
    payload: Page.Create,
    success: Wire.PageWire.pipe(HttpApiSchema.status(201)),
    error: [
      BrandNotFound,
      RetailerNotFound,
      PageAlreadyExists,
      UrlHostMismatch,
    ],
  }),
  HttpApiEndpoint.patch("update", "/pages/:id", {
    params: Wire.IdParams,
    payload: Page.Update,
    success: Wire.PageWire,
    error: [PageNotFound, UrlHostMismatch],
  }),
  HttpApiEndpoint.get("impact", "/pages/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [PageNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/pages/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [PageNotFound],
  }),
) {}
