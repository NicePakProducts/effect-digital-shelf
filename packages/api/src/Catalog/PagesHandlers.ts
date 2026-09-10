import { Pages } from "@digital-shelf/core/Catalog/Pages"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { RootApi } from "../RootApi.ts"
import { toWire } from "./PagesWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "pages", (handlers) =>
  Effect.gen(function* () {
    const pages = yield* Pages
    return handlers
      .handle("list", ({ query }) =>
        pages.list(query).pipe(
          Effect.map((rows) => ({ items: rows.map(toWire) })),
          Effect.catchTag("SqlError", Effect.die),
        ),
      )
      .handle("get", ({ params }) =>
        pages
          .get(params.id)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("create", ({ payload }) =>
        pages
          .create(payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("update", ({ params, payload }) =>
        pages
          .update(params.id, payload)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("impact", ({ params }) =>
        pages.impact(params.id).pipe(Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("remove", ({ params }) =>
        pages.remove(params.id).pipe(Effect.catchTag("SqlError", Effect.die)),
      )
  }),
)
