import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import { ScrapeNotFound } from "@digital-shelf/domain/Scraping/Errors"
import {
  Scrape,
  ScrapeInsert,
  ScrapeUpdate,
  type ScrapeParent,
} from "@digital-shelf/domain/Scraping/Scrape"
import type { ScrapeStatus } from "@digital-shelf/domain/Scraping/Vocabulary"
import {
  ScrapeId,
  type ListingId,
  type PageId,
} from "@digital-shelf/domain/Shared/Ids"
import { Timestamp, nullable } from "@digital-shelf/domain/Shared/Refine"
import { scrapes } from "@digital-shelf/domain/Sql/Scraping"
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import { beforeCursor, type Cursor } from "../../Sql/Keyset.ts"
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

const Backlog = Schema.Struct({
  remaining: Schema.Int,
  oldestCreatedAt: nullable(Timestamp),
})

export class ScrapesRepo extends Context.Service<
  ScrapesRepo,
  {
    readonly find: (
      id: ScrapeId,
    ) => Effect.Effect<Option.Option<Scrape>, SqlError>
    readonly get: (
      id: ScrapeId,
    ) => Effect.Effect<Scrape, ScrapeNotFound | SqlError>
    readonly findInFlight: (
      parent: ScrapeParent,
    ) => Effect.Effect<Option.Option<Scrape>, SqlError>
    readonly insert: (scrape: ScrapeInsert) => Effect.Effect<Scrape, SqlError>
    readonly insertUnlessInFlight: (
      scrape: ScrapeInsert,
    ) => Effect.Effect<Option.Option<Scrape>, SqlError>
    readonly transition: (
      id: ScrapeId,
      from: ScrapeStatus,
      to: ScrapeStatus,
      patch: ScrapeUpdate,
    ) => Effect.Effect<Option.Option<Scrape>, SqlError>
    readonly listPending: (
      limit: number,
    ) => Effect.Effect<ReadonlyArray<Scrape>, SqlError>
    readonly listStuck: (
      before: DateTime.Utc,
    ) => Effect.Effect<ReadonlyArray<Scrape>, SqlError>
    readonly deleteExpired: (
      before: DateTime.Utc,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<ScrapeId>, SqlError>
    readonly expiredBacklog: (
      before: DateTime.Utc,
    ) => Effect.Effect<typeof Backlog.Type, SqlError>
    readonly mostRecentSuccessful: (
      parent: ScrapeParent,
    ) => Effect.Effect<Option.Option<Scrape>, SqlError>
    readonly list: (options: {
      readonly listingId?: ListingId | undefined
      readonly pageId?: PageId | undefined
      readonly status?: ScrapeStatus | undefined
      readonly cursor?: Cursor | undefined
      readonly limit: number
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<Scrape>; readonly hasMore: boolean },
      SqlError
    >
  }
>()("@digital-shelf/core/Scraping/repositories/ScrapesRepo", {
  make: Effect.gen(function* () {
    const db = yield* Db

    const find = Effect.fn("ScrapesRepo.find", { level: "Debug" })(function* (
      id: ScrapeId,
    ) {
      return yield* one(
        yield* query(db.select().from(scrapes).where(eq(scrapes.id, id))),
      )
    })

    const get = (id: ScrapeId) => find(id).pipe(orNotFound(id))

    /** The Parent's Scrape in `pending` or `running`, if any. */
    const findInFlight = Effect.fn("ScrapesRepo.findInFlight", {
      level: "Debug",
    })(function* (parent: ScrapeParent) {
      return yield* one(
        yield* query(
          db
            .select()
            .from(scrapes)
            .where(
              and(
                Predicate.isTagged(parent, "Listing")
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
    const insert = Effect.fn("ScrapesRepo.insert", { level: "Debug" })(
      function* (scrape: ScrapeInsert) {
        return yield* Rows.decodeOne(Scrape)(
          yield* query(db.insert(scrapes).values(toRow(scrape)).returning()),
        )
      },
    )

    /**
     * Insert a `pending` Scrape unless its Parent is in flight, in which case
     * the partial unique index turns the insert into a no-op and this returns
     * `None`. The primary key is a fresh UUID, so no other conflict is possible.
     */
    const insertUnlessInFlight = Effect.fn("ScrapesRepo.insertUnlessInFlight", {
      level: "Debug",
    })(function* (scrape: ScrapeInsert) {
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
    const transition = Effect.fn("ScrapesRepo.transition", {
      level: "Debug",
    })(function* (
      id: ScrapeId,
      from: ScrapeStatus,
      to: ScrapeStatus,
      patch: ScrapeUpdate,
    ) {
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
    const listPending = Effect.fn("ScrapesRepo.listPending", {
      level: "Debug",
    })(function* (limit: number) {
      if (limit <= 0) return []

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
    const listStuck = Effect.fn("ScrapesRepo.listStuck", { level: "Debug" })(
      function* (before: DateTime.Utc) {
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

    /** Terminal Scrapes still waiting for retention, and the oldest of them. */
    const expiredBacklog = Effect.fn("ScrapesRepo.expiredBacklog", {
      level: "Debug",
    })(function* (before: DateTime.Utc) {
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
    })

    const mostRecentSuccessful = Effect.fn("ScrapesRepo.mostRecentSuccessful", {
      level: "Debug",
    })(function* (parent: ScrapeParent) {
      return yield* one(
        yield* query(
          db
            .select()
            .from(scrapes)
            .where(
              and(
                Predicate.isTagged(parent, "Listing")
                  ? eq(scrapes.listingId, parent.listingId)
                  : eq(scrapes.pageId, parent.pageId),
                eq(scrapes.status, "success"),
              ),
            )
            .orderBy(desc(scrapes.createdAt), desc(scrapes.id))
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
              .from(scrapes)
              .where(
                and(
                  options.listingId === undefined
                    ? undefined
                    : eq(scrapes.listingId, options.listingId),
                  options.pageId === undefined
                    ? undefined
                    : eq(scrapes.pageId, options.pageId),
                  options.status === undefined
                    ? undefined
                    : eq(scrapes.status, options.status),
                  beforeCursor(scrapes.createdAt, scrapes.id, options.cursor),
                ),
              )
              .orderBy(desc(scrapes.createdAt), desc(scrapes.id))
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
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
