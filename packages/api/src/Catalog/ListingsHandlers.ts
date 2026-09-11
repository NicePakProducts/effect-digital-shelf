import { Listings } from "@digital-shelf/core/Catalog/Listings"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { RootApi } from "../RootApi.ts"
import { toWire } from "./ListingsWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "listings", (handlers) =>
  Effect.gen(function* () {
    const listings = yield* Listings

    return handlers
      .handle("list", ({ query }) =>
        listings.list(query).pipe(
          Effect.map((rows) => ({ items: rows.map(toWire) })),
          Effect.catchTag("SqlError", Effect.die),
        ),
      )
      .handle("get", ({ params }) =>
        listings
          .get({ listingId: params.id })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("create", ({ payload }) =>
        listings
          .create(payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("update", ({ params, payload }) =>
        listings
          .update({ listingId: params.id, command: payload })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("impact", ({ params }) =>
        listings
          .impact({ listingId: params.id })
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("remove", ({ params }) =>
        listings
          .remove({ listingId: params.id })
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      )
  }),
)
