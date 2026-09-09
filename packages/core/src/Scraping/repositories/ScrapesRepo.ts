import { ScrapeNotFound } from "@digital-shelf/domain/Scraping/Errors"
import {
  Scrape,
  ScrapeInsert,
  ScrapeUpdate,
  type ScrapeParent,
} from "@digital-shelf/domain/Scraping/Scrape"
import type { ScrapeStatus } from "@digital-shelf/domain/Scraping/Vocabulary"
import { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import { Timestamp, nullable } from "@digital-shelf/domain/Shared/Refine"
import { scrapes } from "@digital-shelf/domain/Sql/Scraping"
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Scrape rows. Inserts tolerate the in-flight indexes (`ON CONFLICT DO
 * NOTHING`, returning `None` when the Parent is in flight); every status
 * change is `transition`, a conditional update on the expected source
 * status that returns `None` when it moved nothing (ADR 0004). No
 * transactions here: the calling feature owns them.
 */

const one = Rows.decodeOptional(Scrape)
const all = Rows.decodeAll(Scrape)
const toRow = Rows.encode(ScrapeInsert)
const toPatch = Rows.encode(ScrapeUpdate)

const terminalStatuses: ReadonlyArray<ScrapeStatus> = ["success", "failed"]

const orNotFound =
  (id: ScrapeId) =>
  <R>(
    self: Effect.Effect<Option.Option<Scrape>, SqlError, R>,
  ): Effect.Effect<Scrape, ScrapeNotFound | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new ScrapeNotFound({ scrapeId: id })),
        onSome: Effect.succeed,
      }),
    )

export const find = Effect.fn("ScrapesRepo.find")(function* (id: ScrapeId) {
  const db = yield* Db
  return yield* one(
    yield* query(db.select().from(scrapes).where(eq(scrapes.id, id))),
  )
})

export const get = (id: ScrapeId) => find(id).pipe(orNotFound(id))

/** The Parent's Scrape in `pending` or `running`, if any. */
export const findInFlight = Effect.fn("ScrapesRepo.findInFlight")(function* (
  parent: ScrapeParent,
) {
  const db = yield* Db
  return yield* one(
    yield* query(
      db
        .select()
        .from(scrapes)
        .where(
          and(
            parent._tag === "Listing"
              ? eq(scrapes.listingId, parent.listingId)
              : eq(scrapes.pageId, parent.pageId),
            inArray(scrapes.status, ["pending", "running"]),
          ),
        )
        .limit(1),
    ),
  )
})

/** Manual dispatch uses the partial unique indexes as its refusal. */
export const insert = Effect.fn("ScrapesRepo.insert")(function* (
  scrape: ScrapeInsert,
) {
  const db = yield* Db
  return yield* Rows.decodeOne(Scrape)(
    yield* query(db.insert(scrapes).values(toRow(scrape)).returning()),
  )
})

/**
 * Insert a `pending` Scrape unless its Parent is in flight, in which case
 * the partial unique index turns the insert into a no-op and this returns
 * `None`. The primary key is a fresh UUID, so no other conflict is possible.
 */
export const insertUnlessInFlight = Effect.fn(
  "ScrapesRepo.insertUnlessInFlight",
)(function* (scrape: ScrapeInsert) {
  const db = yield* Db
  return yield* one(
    yield* query(
      db
        .insert(scrapes)
        .values(toRow(scrape))
        .onConflictDoNothing()
        .returning(),
    ),
  )
})

/**
 * `UPDATE ... WHERE id = ? AND status = from RETURNING`: `Some` when this
 * write moved the row, `None` when it did not, and the caller re-reads.
 */
export const transition = Effect.fn("ScrapesRepo.transition")(function* (
  id: ScrapeId,
  from: ScrapeStatus,
  to: ScrapeStatus,
  patch: ScrapeUpdate,
) {
  const db = yield* Db
  return yield* one(
    yield* query(
      db
        .update(scrapes)
        .set({ ...toPatch(patch), status: to })
        .where(and(eq(scrapes.id, id), eq(scrapes.status, from)))
        .returning(),
    ),
  )
})

/** `pending` rows oldest first, for the Cron's drain. */
export const listPending = Effect.fn("ScrapesRepo.listPending")(function* (
  limit: number,
) {
  if (limit <= 0) return []
  const db = yield* Db
  return yield* all(
    yield* query(
      db
        .select()
        .from(scrapes)
        .where(eq(scrapes.status, "pending"))
        .orderBy(asc(scrapes.createdAt), asc(scrapes.id))
        .limit(limit),
    ),
  )
})

/** `running` rows that started before `before`: the stuck sweep's targets. */
export const listStuck = Effect.fn("ScrapesRepo.listStuck")(function* (
  before: DateTime.Utc,
) {
  const db = yield* Db
  return yield* all(
    yield* query(
      db
        .select()
        .from(scrapes)
        .where(
          and(
            eq(scrapes.status, "running"),
            lt(scrapes.startedAt, DateTime.toDateUtc(before)),
          ),
        )
        .orderBy(asc(scrapes.startedAt), asc(scrapes.id)),
    ),
  )
})

/**
 * Remove up to `limit` terminal Scrapes created before `before`, oldest
 * first; Extractions cascade. Returns the ids actually removed so the
 * caller can delete their objects afterwards (ADR 0001).
 */
export const deleteExpired = Effect.fn("ScrapesRepo.deleteExpired")(function* (
  before: DateTime.Utc,
  limit: number,
) {
  if (limit <= 0) return []
  const db = yield* Db
  const expired = db
    .select({ id: scrapes.id })
    .from(scrapes)
    .where(
      and(
        inArray(scrapes.status, terminalStatuses),
        lt(scrapes.createdAt, DateTime.toDateUtc(before)),
      ),
    )
    .orderBy(asc(scrapes.createdAt), asc(scrapes.id))
    .limit(limit)
  const rows = yield* query(
    db
      .delete(scrapes)
      .where(inArray(scrapes.id, expired))
      .returning({ id: scrapes.id }),
  )
  return yield* Rows.decodeAll(Schema.Struct({ id: ScrapeId }))(rows).pipe(
    Effect.map((decoded) => decoded.map((row) => row.id)),
  )
})

const Backlog = Schema.Struct({
  remaining: Schema.Int,
  oldestCreatedAt: nullable(Timestamp),
})

/** Terminal Scrapes still waiting for retention, and the oldest of them. */
export const expiredBacklog = Effect.fn("ScrapesRepo.expiredBacklog")(
  function* (before: DateTime.Utc) {
    const db = yield* Db
    const rows = yield* query(
      db
        .select({
          remaining: sql<number>`count(*)::int`,
          oldestCreatedAt: sql`min(${scrapes.createdAt})`.mapWith(
            scrapes.createdAt,
          ),
        })
        .from(scrapes)
        .where(
          and(
            inArray(scrapes.status, terminalStatuses),
            lt(scrapes.createdAt, DateTime.toDateUtc(before)),
          ),
        ),
    )
    return yield* Rows.decodeOne(Backlog)(rows)
  },
)
