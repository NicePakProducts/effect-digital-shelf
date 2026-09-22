import { PageNotFound, PageAlreadyExists } from "@app/protocol/pages"
import { UrlHostMismatch, RetailerNotFound } from "@app/protocol/retailers"
import { BrandNotFound } from "@app/protocol/brands"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { Pages } from "@app/core/pages"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { Api } from "@app/protocol/api"
import { toWire } from "@app/protocol/page-wire"

export const PagesHandlersLayer = HttpApiBuilder.group(
  Api,
  "pages",
  (handlers) =>
    Effect.gen(function* () {
      const pages = yield* Pages.Service

      return handlers
        .handle("list", ({ query }) =>
          pages.list(query).pipe(
            Effect.map((rows) => ({ items: rows.map(toWire) })),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Pages.list persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("get", ({ params }) =>
          pages.get({ pageId: params.id }).pipe(
            Effect.catchTag("PageNotFound", (error) =>
              Effect.fail(new PageNotFound({ pageId: error.pageId })),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Pages.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("create", ({ payload }) =>
          pages.create(payload).pipe(
            Effect.catchTag("BrandNotFound", (error) =>
              Effect.fail(new BrandNotFound({ brandId: error.brandId })),
            ),
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.catchTag("PageAlreadyExists", (error) =>
              Effect.fail(
                new PageAlreadyExists({
                  brandId: error.brandId,
                  retailerId: error.retailerId,
                  pageId: error.pageId,
                }),
              ),
            ),
            Effect.catchTag("UrlHostMismatch", (error) =>
              Effect.fail(
                new UrlHostMismatch({
                  url: error.url,
                  domain: error.domain,
                  listingIds: error.listingIds,
                  pageIds: error.pageIds,
                }),
              ),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Pages.create persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("update", ({ params, payload }) =>
          pages.update({ pageId: params.id, command: payload }).pipe(
            Effect.catchTag("PageNotFound", (error) =>
              Effect.fail(new PageNotFound({ pageId: error.pageId })),
            ),
            Effect.catchTag("UrlHostMismatch", (error) =>
              Effect.fail(
                new UrlHostMismatch({
                  url: error.url,
                  domain: error.domain,
                  listingIds: error.listingIds,
                  pageIds: error.pageIds,
                }),
              ),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Pages.update persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("impact", ({ params }) =>
          pages.impact({ pageId: params.id }).pipe(
            Effect.catchTag("PageNotFound", (error) =>
              Effect.fail(new PageNotFound({ pageId: error.pageId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Pages.impact persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("remove", ({ params }) =>
          pages.remove({ pageId: params.id }).pipe(
            Effect.catchTag("PageNotFound", (error) =>
              Effect.fail(new PageNotFound({ pageId: error.pageId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Pages.remove persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
    }),
)
