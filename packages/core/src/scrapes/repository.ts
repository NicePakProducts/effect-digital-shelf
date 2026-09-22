import * as Data from "effect/Data"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import { Scrape } from "@app/schema/scrape"
import type { ScrapeStatus } from "@app/schema/scraping-vocabulary"
import { ScrapeId, type ListingId, type PageId } from "@app/schema/ids"
import { Timestamp, nullable } from "@app/schema/refine"
import { ScrapesTable } from "@app/db/schema/scrapes"
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { query } from "../Sql/Errors"
import { beforeCursor, type Cursor } from "../Sql/Keyset"
import * as Rows from "../Sql/Rows"
/**
 * Scrape rows. Inserts tolerate the in-flight indexes (`ON CONFLICT DO
 * NOTHING`, returning `None` when the Parent is in flight); every status
 * change is `transition`, a conditional update on the expected source
 * status that returns `None` when it moved nothing (ADR 0004). No
 * transactions here: the calling feature owns them.
 */

const one = Rows.decodeOptional(Scrape.Info)

const all = Rows.decodeAll(Scrape.Info)

const toRow = Rows.encode(Scrape.Insert)

const toPatch = Rows.encode(Scrape.UpdateRow)

const terminalStatuses: ReadonlyArray<ScrapeStatus> = ["success", "failed"]

const orNotFound =
  (id: ScrapeId) =>
  <R>(
    self: Effect.Effect<Option.Option<Scrape.Info>, SqlError, R>,
  ): Effect.Effect<Scrape.Info, MissingScrape | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new MissingScrape({ scrapeId: id })),
        onSome: Effect.succeed,
      }),
    )

const Backlog = Schema.Struct({
  remaining: Schema.Int,
  oldestCreatedAt: nullable(Timestamp),
})

export * as ScrapesRepo from "./repository"

export interface Interface {
  readonly find: (
    id: ScrapeId,
  ) => Effect.Effect<Option.Option<Scrape.Info>, SqlError>
  readonly get: (
    id: ScrapeId,
  ) => Effect.Effect<Scrape.Info, MissingScrape | SqlError>
  readonly findInFlight: (
    parent: Scrape.Parent,
  ) => Effect.Effect<Option.Option<Scrape.Info>, SqlError>
  readonly insert: (
    scrape: Scrape.Insert,
  ) => Effect.Effect<Scrape.Info, SqlError>
  readonly insertUnlessInFlight: (
    scrape: Scrape.Insert,
  ) => Effect.Effect<Option.Option<Scrape.Info>, SqlError>
  readonly transition: (
    id: ScrapeId,
    from: ScrapeStatus,
    to: ScrapeStatus,
    patch: Scrape.UpdateRow,
  ) => Effect.Effect<Option.Option<Scrape.Info>, SqlError>
  readonly listPending: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Scrape.Info>, SqlError>
  readonly listStuck: (
    before: DateTime.Utc,
  ) => Effect.Effect<ReadonlyArray<Scrape.Info>, SqlError>
  readonly deleteExpired: (
    before: DateTime.Utc,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ScrapeId>, SqlError>
  readonly expiredBacklog: (
    before: DateTime.Utc,
  ) => Effect.Effect<typeof Backlog.Type, SqlError>
  readonly mostRecentSuccessful: (
    parent: Scrape.Parent,
  ) => Effect.Effect<Option.Option<Scrape.Info>, SqlError>
  readonly list: (options: {
    readonly listingId?: ListingId | undefined
    readonly pageId?: PageId | undefined
    readonly status?: ScrapeStatus | undefined
    readonly cursor?: Cursor | undefined
    readonly limit: number
  }) => Effect.Effect<
    { readonly items: ReadonlyArray<Scrape.Info>; readonly hasMore: boolean },
    SqlError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const find = Effect.fn("ScrapesRepo.find", { level: "Debug" })(function* (
    id: ScrapeId,
  ) {
    return yield* one(
      yield* query(
        db.select().from(ScrapesTable).where(eq(ScrapesTable.id, id)),
      ),
    )
  })

  const get = (id: ScrapeId) => find(id).pipe(orNotFound(id))

  /** The Parent's Scrape in `pending` or `running`, if any. */
  const findInFlight = Effect.fn("ScrapesRepo.findInFlight", {
    level: "Debug",
  })(function* (parent: Scrape.Parent) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(ScrapesTable)
          .where(
            and(
              Predicate.isTagged(parent, "Listing")
                ? eq(ScrapesTable.listingId, parent.listingId)
                : eq(ScrapesTable.pageId, parent.pageId),
              inArray(ScrapesTable.status, ["pending", "running"]),
            ),
          )
          .limit(1),
      ),
    )
  })

  /** Manual dispatch uses the partial unique indexes as its refusal. */
  const insert = Effect.fn("ScrapesRepo.insert", { level: "Debug" })(function* (
    scrape: Scrape.Insert,
  ) {
    return yield* Rows.decodeOne(Scrape.Info)(
      yield* query(db.insert(ScrapesTable).values(toRow(scrape)).returning()),
    )
  })

  /**
   * Insert a `pending` Scrape unless its Parent is in flight, in which case
   * the partial unique index turns the insert into a no-op and this returns
   * `None`. The primary key is a fresh UUID, so no other conflict is possible.
   */
  const insertUnlessInFlight = Effect.fn("ScrapesRepo.insertUnlessInFlight", {
    level: "Debug",
  })(function* (scrape: Scrape.Insert) {
    return yield* one(
      yield* query(
        db
          .insert(ScrapesTable)
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
  const transition = Effect.fn("ScrapesRepo.transition", {
    level: "Debug",
  })(function* (
    id: ScrapeId,
    from: ScrapeStatus,
    to: ScrapeStatus,
    patch: Scrape.UpdateRow,
  ) {
    return yield* one(
      yield* query(
        db
          .update(ScrapesTable)
          .set({ ...toPatch(patch), status: to })
          .where(and(eq(ScrapesTable.id, id), eq(ScrapesTable.status, from)))
          .returning(),
      ),
    )
  })

  /** `pending` rows oldest first, for the Cron's drain. */
  const listPending = Effect.fn("ScrapesRepo.listPending", {
    level: "Debug",
  })(function* (limit: number) {
    if (limit <= 0) return []

    return yield* all(
      yield* query(
        db
          .select()
          .from(ScrapesTable)
          .where(eq(ScrapesTable.status, "pending"))
          .orderBy(asc(ScrapesTable.createdAt), asc(ScrapesTable.id))
          .limit(limit),
      ),
    )
  })

  /** `running` rows that started before `before`: the stuck sweep's targets. */
  const listStuck = Effect.fn("ScrapesRepo.listStuck", { level: "Debug" })(
    function* (before: DateTime.Utc) {
      return yield* all(
        yield* query(
          db
            .select()
            .from(ScrapesTable)
            .where(
              and(
                eq(ScrapesTable.status, "running"),
                lt(ScrapesTable.startedAt, DateTime.toDateUtc(before)),
              ),
            )
            .orderBy(asc(ScrapesTable.startedAt), asc(ScrapesTable.id)),
        ),
      )
    },
  )

  /**
   * Remove up to `limit` terminal Scrapes created before `before`, oldest
   * first; Extractions cascade. Returns the ids actually removed so the
   * caller can delete their objects afterwards (ADR 0001).
   */
  const deleteExpired = Effect.fn("ScrapesRepo.deleteExpired", {
    level: "Debug",
  })(function* (before: DateTime.Utc, limit: number) {
    if (limit <= 0) return []

    const expired = db
      .select({ id: ScrapesTable.id })
      .from(ScrapesTable)
      .where(
        and(
          inArray(ScrapesTable.status, terminalStatuses),
          lt(ScrapesTable.createdAt, DateTime.toDateUtc(before)),
        ),
      )
      .orderBy(asc(ScrapesTable.createdAt), asc(ScrapesTable.id))
      .limit(limit)

    const rows = yield* query(
      db
        .delete(ScrapesTable)
        .where(inArray(ScrapesTable.id, expired))
        .returning({ id: ScrapesTable.id }),
    )

    return yield* Rows.decodeAll(Schema.Struct({ id: ScrapeId }))(rows).pipe(
      Effect.map((decoded) => decoded.map((row) => row.id)),
    )
  })

  /** Terminal Scrapes still waiting for retention, and the oldest of them. */
  const expiredBacklog = Effect.fn("ScrapesRepo.expiredBacklog", {
    level: "Debug",
  })(function* (before: DateTime.Utc) {
    const rows = yield* query(
      db
        .select({
          remaining: sql<number>`count(*)::int`,
          oldestCreatedAt: sql`min(${ScrapesTable.createdAt})`.mapWith(
            ScrapesTable.createdAt,
          ),
        })
        .from(ScrapesTable)
        .where(
          and(
            inArray(ScrapesTable.status, terminalStatuses),
            lt(ScrapesTable.createdAt, DateTime.toDateUtc(before)),
          ),
        ),
    )

    return yield* Rows.decodeOne(Backlog)(rows)
  })

  const mostRecentSuccessful = Effect.fn("ScrapesRepo.mostRecentSuccessful", {
    level: "Debug",
  })(function* (parent: Scrape.Parent) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(ScrapesTable)
          .where(
            and(
              Predicate.isTagged(parent, "Listing")
                ? eq(ScrapesTable.listingId, parent.listingId)
                : eq(ScrapesTable.pageId, parent.pageId),
              eq(ScrapesTable.status, "success"),
            ),
          )
          .orderBy(desc(ScrapesTable.createdAt), desc(ScrapesTable.id))
          .limit(1),
      ),
    )
  })

  /**
   * One page of Scrapes, newest first, over the `(created_at, id)` keyset the
   * cursor names. One extra row is read so the caller knows whether another
   * page exists without a second query.
   */
  const list = Effect.fn("ScrapesRepo.list", { level: "Debug" })(
    function* (options: {
      readonly listingId?: ListingId | undefined
      readonly pageId?: PageId | undefined
      readonly status?: ScrapeStatus | undefined
      readonly cursor?: Cursor | undefined
      readonly limit: number
    }) {
      const rows = yield* all(
        yield* query(
          db
            .select()
            .from(ScrapesTable)
            .where(
              and(
                options.listingId === undefined
                  ? undefined
                  : eq(ScrapesTable.listingId, options.listingId),
                options.pageId === undefined
                  ? undefined
                  : eq(ScrapesTable.pageId, options.pageId),
                options.status === undefined
                  ? undefined
                  : eq(ScrapesTable.status, options.status),
                beforeCursor(
                  ScrapesTable.createdAt,
                  ScrapesTable.id,
                  options.cursor,
                ),
              ),
            )
            .orderBy(desc(ScrapesTable.createdAt), desc(ScrapesTable.id))
            .limit(options.limit + 1),
        ),
      )

      return {
        items: rows.slice(0, options.limit),
        hasMore: rows.length > options.limit,
      }
    },
  )

  return {
    find,
    get,
    findInFlight,
    insert,
    insertUnlessInFlight,
    transition,
    listPending,
    listStuck,
    deleteExpired,
    expiredBacklog,
    mostRecentSuccessful,
    list,
  } as const
})

export const layer = Layer.effect(Service, make)

export class MissingScrape extends Data.TaggedError("MissingScrape")<{
  readonly scrapeId: ScrapeId
}> {}
