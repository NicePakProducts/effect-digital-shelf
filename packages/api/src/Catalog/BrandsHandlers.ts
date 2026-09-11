import { Brands } from "@digital-shelf/core/Catalog/Brands"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { RootApi } from "../RootApi.ts"
import { toWire } from "./BrandsWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "brands", (handlers) =>
  Effect.gen(function* () {
    const brands = yield* Brands

    return handlers
      .handle("list", () =>
        brands.list.pipe(
          Effect.map((rows) => ({ items: rows.map(toWire) })),
          Effect.catchTag("SqlError", Effect.die),
        ),
      )
      .handle("get", ({ params }) =>
        brands
          .get(params.id)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("create", ({ payload }) =>
        brands
          .create(payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("update", ({ params, payload }) =>
        brands
          .update(params.id, payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("impact", ({ params }) =>
        brands.impact(params.id).pipe(Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("remove", ({ params }) =>
        brands.remove(params.id).pipe(Effect.catchTag("SqlError", Effect.die)),
      )
  }),
)
