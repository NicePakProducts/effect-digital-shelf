import { ListingNotFound, VariantNotInProduct } from "@app/protocol/listings"
import { UrlHostMismatch, RetailerNotFound } from "@app/protocol/retailers"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { ProductNotFound } from "@app/protocol/products"
import { Listings } from "@app/core/listings"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { Api } from "@app/protocol/api"
import { toWire } from "@app/protocol/listing-wire"

export const ListingsHandlersLayer = HttpApiBuilder.group(
  Api,
  "listings",
  (handlers) =>
    Effect.gen(function* () {
      const listings = yield* Listings.Service

      return handlers
        .handle("list", ({ query }) =>
          listings.list(query).pipe(
            Effect.map((rows) => ({ items: rows.map(toWire) })),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Listings.list persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("get", ({ params }) =>
          listings.get({ listingId: params.id }).pipe(
            Effect.catchTag("ListingNotFound", (error) =>
              Effect.fail(new ListingNotFound({ listingId: error.listingId })),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Listings.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("create", ({ payload }) =>
          listings.create(payload).pipe(
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.catchTag("VariantNotInProduct", (error) =>
              Effect.fail(
                new VariantNotInProduct({
                  variantId: error.variantId,
                  productId: error.productId,
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
            Effect.catchTag("ProductNotFound", (error) =>
              Effect.fail(new ProductNotFound({ productId: error.productId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Listings.create persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("update", ({ params, payload }) =>
          listings.update({ listingId: params.id, command: payload }).pipe(
            Effect.catchTag("ListingNotFound", (error) =>
              Effect.fail(new ListingNotFound({ listingId: error.listingId })),
            ),
            Effect.catchTag("VariantNotInProduct", (error) =>
              Effect.fail(
                new VariantNotInProduct({
                  variantId: error.variantId,
                  productId: error.productId,
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
              Effect.logError("Listings.update persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("impact", ({ params }) =>
          listings.impact({ listingId: params.id }).pipe(
            Effect.catchTag("ListingNotFound", (error) =>
              Effect.fail(new ListingNotFound({ listingId: error.listingId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Listings.impact persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("remove", ({ params }) =>
          listings.remove({ listingId: params.id }).pipe(
            Effect.catchTag("ListingNotFound", (error) =>
              Effect.fail(new ListingNotFound({ listingId: error.listingId })),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Listings.remove persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
    }),
)
