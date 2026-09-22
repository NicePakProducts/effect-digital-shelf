export * as ScrapesErrors from "./errors"

import * as Data from "effect/Data"
import type { ScrapeId } from "@app/schema/ids"
import type { Scrape } from "@app/schema/scrape"

export class NotFound extends Data.TaggedError("ScrapeNotFound")<{
  readonly scrapeId: ScrapeId
}> {}

export class ParentInFlight extends Data.TaggedError("ParentInFlight")<{
  readonly parent: Scrape.Parent
  readonly scrapeId: ScrapeId
}> {}
