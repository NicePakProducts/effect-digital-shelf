import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { ScrapeNotFound } from "@digital-shelf/domain/Scraping/Errors"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { defaultLimit, page, parseCursor } from "../PaginationWire.ts"
import { RootApi } from "../RootApi.ts"
import { toWire } from "./ScrapesWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "scrapes", (handlers) =>
  Effect.gen(function* () {
    const scrapes = yield* Scrapes
    return handlers
      .handle("list", ({ query }) =>
        scrapes
          .list({
            listingId: query.listingId,
            pageId: query.pageId,
            status: query.status,
            cursor:
              query.cursor === undefined
                ? undefined
                : parseCursor(query.cursor),
            limit: query.limit ?? defaultLimit,
          })
          .pipe(
            Effect.map((result) => page(result, toWire)),
            Effect.catchTag("SqlError", Effect.die),
          ),
      )
      .handle("get", ({ params }) =>
        scrapes
          .get(params.id)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("content", ({ params }) =>
        scrapes.content(params.id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ScrapeNotFound({ scrapeId: params.id })),
              onSome: Effect.succeed,
            }),
          ),
          Effect.catchTags({
            SqlError: Effect.die,
            StorageError: Effect.die,
          }),
        ),
      )
      .handle("trigger", ({ payload }) =>
        scrapes.trigger(payload).pipe(
          Effect.map(toWire),
          // The row is committed; a Workflow that will not start is ours, not
          // the caller's, and the Cron's drain picks the Scrape up again.
          Effect.catchTags({
            SqlError: Effect.die,
            ExecutionsError: Effect.die,
          }),
        ),
      )
      .handle("bulk", ({ payload }) =>
        scrapes.bulk(payload).pipe(
          Effect.map((report) => ({
            created: report.created.length,
            skippedInFlight: report.skipped.length,
            skippedPaused: report.skippedPaused.length,
          })),
          Effect.catchTags({
            SqlError: Effect.die,
            ExecutionsError: Effect.die,
          }),
        ),
      )
  }),
)
