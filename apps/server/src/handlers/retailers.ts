import {
  RetailerNotFound,
  InvalidRetailerDomain,
  RetailerDomainTaken,
  UrlHostMismatch,
} from "@app/protocol/retailers"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { Retailers } from "@app/core/retailers"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { Api } from "@app/protocol/api"
import { toWire } from "@app/protocol/retailer-wire"

export const RetailersHandlersLayer = HttpApiBuilder.group(
  Api,
  "retailers",
  (handlers) =>
    Effect.gen(function* () {
      const retailers = yield* Retailers.Service

      return handlers
        .handle("list", () =>
          retailers.list.pipe(
            Effect.map((rows) => ({ items: rows.map(toWire) })),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Retailers.list persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("get", ({ params }) =>
          retailers.get({ retailerId: params.id }).pipe(
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Retailers.get persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("create", ({ payload }) =>
          retailers.create(payload).pipe(
            Effect.catchTag("InvalidRetailerDomain", (error) =>
              Effect.fail(new InvalidRetailerDomain({ input: error.input })),
            ),
            Effect.catchTag("RetailerDomainTaken", (error) =>
              Effect.fail(
                new RetailerDomainTaken({
                  domain: error.domain,
                  retailerId: error.retailerId,
                }),
              ),
            ),
            Effect.map(toWire),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Retailers.create persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("update", ({ params, payload }) =>
          retailers.update({ retailerId: params.id, command: payload }).pipe(
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.catchTag("InvalidRetailerDomain", (error) =>
              Effect.fail(new InvalidRetailerDomain({ input: error.input })),
            ),
            Effect.catchTag("RetailerDomainTaken", (error) =>
              Effect.fail(
                new RetailerDomainTaken({
                  domain: error.domain,
                  retailerId: error.retailerId,
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
              Effect.logError("Retailers.update persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("impact", ({ params }) =>
          retailers.impact({ retailerId: params.id }).pipe(
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Retailers.impact persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
        .handle("remove", ({ params }) =>
          retailers.remove({ retailerId: params.id }).pipe(
            Effect.catchTag("RetailerNotFound", (error) =>
              Effect.fail(
                new RetailerNotFound({ retailerId: error.retailerId }),
              ),
            ),
            Effect.catchTag("SqlError", () =>
              Effect.logError("Retailers.remove persistence failed").pipe(
                Effect.as(HttpServerResponse.empty({ status: 500 })),
              ),
            ),
          ),
        )
    }),
)
