import { Variants } from "@digital-shelf/core/Catalog/Variants"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { RootApi } from "../RootApi.ts"
import { toWire } from "./VariantsWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "variants", (handlers) =>
  Effect.gen(function* () {
    const variants = yield* Variants

    return handlers
      .handle("list", ({ query }) =>
        variants.list(query).pipe(
          Effect.map((rows) => ({ items: rows.map(toWire) })),
          Effect.catchTag("SqlError", Effect.die),
        ),
      )
      .handle("get", ({ params }) =>
        variants
          .get({ variantId: params.id })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("create", ({ payload }) =>
        variants
          .create(payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("update", ({ params, payload }) =>
        variants
          .update({ variantId: params.id, command: payload })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("remove", ({ params }) =>
        variants
          .remove({ variantId: params.id })
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      )
  }),
)
