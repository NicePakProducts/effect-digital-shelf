import { Products } from "@digital-shelf/core/Catalog/Products"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { RootApi } from "../RootApi.ts"
import { toWire } from "./ProductsWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "products", (handlers) =>
  Effect.gen(function* () {
    const products = yield* Products

    return handlers
      .handle("list", ({ query }) =>
        products.list(query).pipe(
          Effect.map((rows) => ({ items: rows.map(toWire) })),
          Effect.catchTag("SqlError", Effect.die),
        ),
      )
      .handle("get", ({ params }) =>
        products
          .get({ productId: params.id })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("create", ({ payload }) =>
        products
          .create(payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("update", ({ params, payload }) =>
        products
          .update({ productId: params.id, command: payload })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("impact", ({ params }) =>
        products
          .impact({ productId: params.id })
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("remove", ({ params }) =>
        products
          .remove({ productId: params.id })
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      )
  }),
)
