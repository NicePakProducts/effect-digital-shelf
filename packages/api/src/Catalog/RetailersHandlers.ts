import { Retailers } from "@digital-shelf/core/Catalog/Retailers"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { RootApi } from "../RootApi.ts"
import { toWire } from "./RetailersWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "retailers", (handlers) =>
  Effect.gen(function* () {
    const retailers = yield* Retailers

    return handlers
      .handle("list", () =>
        retailers.list.pipe(
          Effect.map((rows) => ({ items: rows.map(toWire) })),
          Effect.catchTag("SqlError", Effect.die),
        ),
      )
      .handle("get", ({ params }) =>
        retailers
          .get({ retailerId: params.id })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("create", ({ payload }) =>
        retailers
          .create(payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("update", ({ params, payload }) =>
        retailers
          .update({ retailerId: params.id, command: payload })
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("impact", ({ params }) =>
        retailers
          .impact({ retailerId: params.id })
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("remove", ({ params }) =>
        retailers
          .remove({ retailerId: params.id })
          .pipe(Effect.catchTag("SqlError", Effect.die)),
      )
  }),
)
