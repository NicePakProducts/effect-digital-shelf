import {
  Extraction,
  ExtractionInsert,
} from "@digital-shelf/domain/Scraping/Extraction"
import type { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import { extractions } from "@digital-shelf/domain/Sql/Scraping"
import { and, desc, eq } from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * The slice of Extraction rows the Scrape lifecycle needs: the initial
 * extract every successful Scrape spawns inside its `finish` transaction,
 * and the lookup that starts it after commit. The Extraction lifecycle
 * landing owns the rest.
 */

const one = Rows.decodeOptional(Extraction)
const exactlyOne = Rows.decodeOne(Extraction)
const toRow = Rows.encode(ExtractionInsert)

export const insert = Effect.fn("ExtractionsRepo.insert")(function* (
  extraction: ExtractionInsert,
) {
  const db = yield* Db
  return yield* exactlyOne(
    yield* query(db.insert(extractions).values(toRow(extraction)).returning()),
  )
})

/** The Scrape's `pending` Extraction, if any (at most one by index). */
export const findPending = Effect.fn("ExtractionsRepo.findPending")(function* (
  scrapeId: ScrapeId,
) {
  const db = yield* Db
  return yield* one(
    yield* query(
      db
        .select()
        .from(extractions)
        .where(
          and(
            eq(extractions.scrapeId, scrapeId),
            eq(extractions.status, "pending"),
          ),
        )
        .orderBy(desc(extractions.attempt))
        .limit(1),
    ),
  )
})
