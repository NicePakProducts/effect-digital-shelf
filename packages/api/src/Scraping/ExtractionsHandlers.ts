import { Extractions } from "@digital-shelf/core/Scraping/Extractions"
import { NoExtractedData } from "@digital-shelf/domain/Scraping/Errors"
import type { ScrapeParent } from "@digital-shelf/domain/Scraping/Scrape"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { defaultLimit, page, parseCursor } from "../PaginationWire.ts"
import { RootApi } from "../RootApi.ts"
import { toLatestWire, toWire } from "./ExtractionsWire.ts"

export const layer = HttpApiBuilder.group(RootApi, "extractions", (handlers) =>
  Effect.gen(function* () {
    const extractions = yield* Extractions
    /** The latest reads answer 404 when the Parent has no successful Extraction. */
    const latest = (parent: ScrapeParent) =>
      extractions.latestExtractedData(parent).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NoExtractedData({ parent })),
            onSome: (data) => Effect.succeed(toLatestWire(data)),
          }),
        ),
        Effect.catchTag("SqlError", Effect.die),
      )
    return handlers
      .handle("list", ({ query }) =>
        extractions
          .list({
            scrapeId: query.scrapeId,
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
        extractions
          .get(params.id)
          .pipe(Effect.map(toWire), Effect.catchTag("SqlError", Effect.die)),
      )
      .handle("trigger", ({ payload }) =>
        extractions.trigger(payload).pipe(
          Effect.map(toWire),
          // The row is committed; a Workflow that will not start is ours, not
          // the caller's, and the Cron's drain picks the Extraction up again.
          Effect.catchTags({
            SqlError: Effect.die,
            ExecutionsError: Effect.die,
          }),
        ),
      )
      .handle("bulk", ({ payload }) =>
        extractions.bulk(payload).pipe(
          Effect.map((report) => ({
            created: report.created.length,
            skipped: report.skipped,
          })),
          Effect.catchTags({
            SqlError: Effect.die,
            ExecutionsError: Effect.die,
          }),
        ),
      )
      .handle("latestForListing", ({ params }) =>
        latest({ _tag: "Listing", listingId: params.id }),
      )
      .handle("latestForPage", ({ params }) =>
        latest({ _tag: "Page", pageId: params.id }),
      )
      .handle("latestForProduct", ({ params }) =>
        extractions.latestExtractedDataForProduct(params.id).pipe(
          Effect.map((rows) => ({ items: rows.map(toLatestWire) })),
          Effect.catchTag("SqlError", Effect.die),
        ),
      )
  }),
)
