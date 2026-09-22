import * as Data from "effect/Data"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Predicate from "effect/Predicate"
import { Execution } from "@app/schema/execution"
import { LatestExtractedData } from "@app/schema/latest-extracted-data"
import { Scrape } from "@app/schema/scrape"
import type {
  ExtractionStatus,
  PromptKind,
} from "@app/schema/scraping-vocabulary"
import { ListingsTable } from "@app/db/schema/listings"
import { PagesTable } from "@app/db/schema/pages"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Extraction } from "@app/schema/extraction"
import {
  ScrapeId,
  ExtractionId,
  ListingId,
  type ProductId,
  type RetailerId,
} from "@app/schema/ids"
import { ExtractionsTable } from "@app/db/schema/extractions"
import { ScrapesTable } from "@app/db/schema/scrapes"
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  lt,
  sql,
  type SQL,
} from "drizzle-orm"
import * as Effect from "effect/Effect"
import { Db } from "@app/db"
import { query } from "../../Sql/Errors"
import { beforeCursor, type Cursor } from "../../Sql/Keyset"
import * as Rows from "../../Sql/Rows"
/** Extraction queries and conditional writes; features own transactions. */

const one = Rows.decodeOptional(Extraction.Info)

const exactlyOne = Rows.decodeOne(Extraction.Info)

const toRow = Rows.encode(Extraction.Insert)

export const TracedExtraction = Schema.Struct({
  ...Extraction.Info.fields,
  rootSpanId: Execution.SpanId,
})

const dataColumns = {
  scrapeId: sql`${ScrapesTable.id}`.mapWith(ScrapesTable.id).as("scrape_id"),
  fetchedAt: sql`${ScrapesTable.finishedAt}`
    .mapWith(ScrapesTable.finishedAt)
    .as("fetched_at"),
  extractionId: sql`${ExtractionsTable.id}`
    .mapWith(ExtractionsTable.id)
    .as("extraction_id"),
  extractedAt: sql`${ExtractionsTable.finishedAt}`
    .mapWith(ExtractionsTable.finishedAt)
    .as("extracted_at"),
  prompt: ExtractionsTable.promptSnapshot,
  model: ExtractionsTable.model,
  data: ExtractionsTable.extractedJson,
}

const dataQuery = (db: Db["Service"], condition: SQL) =>
  db
    .select(dataColumns)
    .from(ScrapesTable)
    .innerJoin(
      ExtractionsTable,
      and(
        eq(ExtractionsTable.scrapeId, ScrapesTable.id),
        eq(ExtractionsTable.status, "success"),
      ),
    )
    .where(condition)
    .orderBy(
      desc(ScrapesTable.createdAt),
      desc(ScrapesTable.id),
      desc(ExtractionsTable.attempt),
    )
    .limit(1)

// SAFETY: This database projection must satisfy its row schema; a mismatch can only be a bug.
const decodeData = (
  parent: Scrape.Parent,
  row: {
    scrapeId: string
    fetchedAt: Date | null
    extractionId: string
    extractedAt: Date | null
    prompt: string
    model: string
    data: unknown
  },
) =>
  Schema.decodeUnknownEffect(LatestExtractedData.Info)({
    parent,
    data: row.data,
    provenance: row,
  }).pipe(Effect.orDie)

export * as ExtractionsRepo from "./repository"

export interface Interface {
  readonly insert: (
    extraction: Extraction.Insert,
  ) => Effect.Effect<Extraction.Info, SqlError>
  readonly findPending: (
    scrapeId: ScrapeId,
  ) => Effect.Effect<Option.Option<Extraction.Info>, SqlError>
  readonly findInitial: (
    scrapeId: ScrapeId,
  ) => Effect.Effect<Option.Option<Extraction.Info>, SqlError>
  readonly find: (
    id: ExtractionId,
  ) => Effect.Effect<Option.Option<Extraction.Info>, SqlError>
  readonly get: (
    id: ExtractionId,
  ) => Effect.Effect<Extraction.Info, MissingExtraction | SqlError>
  readonly allocate: (
    values: Omit<Extraction.Insert, "attempt">,
    options: { tolerateConflict: boolean },
  ) => Effect.Effect<Option.Option<Extraction.Info>, SqlError>
  readonly findInFlight: (
    scrapeId: ScrapeId,
  ) => Effect.Effect<Option.Option<Extraction.Info>, SqlError>
  readonly transition: (
    id: ExtractionId,
    from: ExtractionStatus,
    to: ExtractionStatus,
    patch: Extraction.UpdateRow,
  ) => Effect.Effect<Option.Option<Extraction.Info>, SqlError>
  readonly listPending: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<typeof TracedExtraction.Type>, SqlError>
  readonly listStuck: (
    before: DateTime.Utc,
  ) => Effect.Effect<ReadonlyArray<typeof TracedExtraction.Type>, SqlError>
  readonly listByScrape: (
    scrapeId: ScrapeId,
  ) => Effect.Effect<ReadonlyArray<Extraction.Info>, SqlError>
  readonly latestSuccessful: (
    scrapeId: ScrapeId,
  ) => Effect.Effect<Option.Option<Extraction.Info>, SqlError>
  readonly latestExtractedData: (
    parent: Scrape.Parent,
  ) => Effect.Effect<Option.Option<LatestExtractedData.Info>, SqlError>
  readonly latestExtractedDataForProduct: (
    productId: ProductId,
  ) => Effect.Effect<ReadonlyArray<LatestExtractedData.Info>, SqlError>
  readonly bulkCandidates: (
    retailerId: RetailerId,
    promptKind: PromptKind,
    prompt: string,
    model: string,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly scrapeId: ScrapeId
      readonly rootSpanId: Execution.SpanId
      readonly hasHtml: boolean
      readonly matching: boolean
      readonly promptKind: PromptKind
    }>,
    SqlError
  >
  readonly list: (options: {
    readonly scrapeId?: ScrapeId | undefined
    readonly status?: ExtractionStatus | undefined
    readonly cursor?: Cursor | undefined
    readonly limit: number
  }) => Effect.Effect<
    {
      readonly items: ReadonlyArray<Extraction.Info>
      readonly hasMore: boolean
    },
    SqlError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/extractions/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  const insert = Effect.fn("ExtractionsRepo.insert", { level: "Debug" })(
    function* (extraction: Extraction.Insert) {
      return yield* exactlyOne(
        yield* query(
          db.insert(ExtractionsTable).values(toRow(extraction)).returning(),
        ),
      )
    },
  )

  /** The Scrape's `pending` Extraction, if any (at most one by index). */
  const findPending = Effect.fn("ExtractionsRepo.findPending", {
    level: "Debug",
  })(function* (scrapeId: ScrapeId) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(ExtractionsTable)
          .where(
            and(
              eq(ExtractionsTable.scrapeId, scrapeId),
              eq(ExtractionsTable.status, "pending"),
            ),
          )
          .orderBy(desc(ExtractionsTable.attempt))
          .limit(1),
      ),
    )
  })

  /** Attempt one remains the replay result even after Extraction progresses. */
  const findInitial = Effect.fn("ExtractionsRepo.findInitial", {
    level: "Debug",
  })(function* (scrapeId: ScrapeId) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(ExtractionsTable)
          .where(
            and(
              eq(ExtractionsTable.scrapeId, scrapeId),
              eq(ExtractionsTable.attempt, 1),
            ),
          ),
      ),
    )
  })

  const find = Effect.fn("ExtractionsRepo.find", { level: "Debug" })(function* (
    id: ExtractionId,
  ) {
    return yield* one(
      yield* query(
        db.select().from(ExtractionsTable).where(eq(ExtractionsTable.id, id)),
      ),
    )
  })

  const get = (id: ExtractionId) =>
    find(id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new MissingExtraction({ extractionId: id })),
          onSome: Effect.succeed,
        }),
      ),
    )

  /** Allocation and both race backstops run in one statement. */
  const allocate = Effect.fn("ExtractionsRepo.allocate", {
    level: "Debug",
  })(function* (
    values: Omit<Extraction.Insert, "attempt">,
    options: { tolerateConflict: boolean },
  ) {
    const now = yield* DateTime.now

    const encoded = toRow({
      ...values,
      attempt: 1,
      id:
        values.id ??
        // SAFETY: A freshly generated UUID must satisfy ExtractionId; a mismatch can only be a bug.
        (yield* Schema.decodeEffect(ExtractionId)(crypto.randomUUID()).pipe(
          Effect.orDie,
        )),
      createdAt: values.createdAt ?? now,
      updatedAt: values.updatedAt ?? now,
    })

    // SAFETY: Both columns and encoded fields derive from the extractions table; missing optional insert values intentionally become SQL NULL.
    const fields = Object.entries(getTableColumns(ExtractionsTable)).map(
      ([key, column]) =>
        key === "attempt"
          ? sql`coalesce(max(${ExtractionsTable.attempt}), 0) + 1`
          : sql`${sql.param(encoded[key as keyof typeof encoded] ?? null, column)}`,
    )

    const statement = db
      .insert(ExtractionsTable)
      .select(
        sql`SELECT ${sql.join(fields, sql`, `)} FROM ${ExtractionsTable} WHERE ${ExtractionsTable.scrapeId} = ${values.scrapeId}`,
      )

    return yield* one(
      yield* query(
        options.tolerateConflict
          ? statement.onConflictDoNothing().returning()
          : statement.returning(),
      ),
    )
  })

  const findInFlight = Effect.fn("ExtractionsRepo.findInFlight", {
    level: "Debug",
  })(function* (scrapeId: ScrapeId) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(ExtractionsTable)
          .where(
            and(
              eq(ExtractionsTable.scrapeId, scrapeId),
              inArray(ExtractionsTable.status, ["pending", "running"]),
            ),
          )
          .limit(1),
      ),
    )
  })

  const transition = Effect.fn("ExtractionsRepo.transition", {
    level: "Debug",
  })(function* (
    id: ExtractionId,
    from: ExtractionStatus,
    to: ExtractionStatus,
    patch: Extraction.UpdateRow,
  ) {
    return yield* one(
      yield* query(
        db
          .update(ExtractionsTable)
          .set({ ...Rows.encode(Extraction.UpdateRow)(patch), status: to })
          .where(
            and(eq(ExtractionsTable.id, id), eq(ExtractionsTable.status, from)),
          )
          .returning(),
      ),
    )
  })

  const listPending = Effect.fn("ExtractionsRepo.listPending", {
    level: "Debug",
  })(function* (limit: number) {
    if (limit <= 0) return []

    return yield* Rows.decodeAll(TracedExtraction)(
      yield* query(
        db
          .select({
            ...getTableColumns(ExtractionsTable),
            rootSpanId: ScrapesTable.rootSpanId,
          })
          .from(ExtractionsTable)
          .innerJoin(
            ScrapesTable,
            eq(ScrapesTable.id, ExtractionsTable.scrapeId),
          )
          .where(eq(ExtractionsTable.status, "pending"))
          .orderBy(asc(ExtractionsTable.createdAt), asc(ExtractionsTable.id))
          .limit(limit),
      ),
    )
  })

  const listStuck = Effect.fn("ExtractionsRepo.listStuck", {
    level: "Debug",
  })(function* (before: DateTime.Utc) {
    return yield* Rows.decodeAll(TracedExtraction)(
      yield* query(
        db
          .select({
            ...getTableColumns(ExtractionsTable),
            rootSpanId: ScrapesTable.rootSpanId,
          })
          .from(ExtractionsTable)
          .innerJoin(
            ScrapesTable,
            eq(ScrapesTable.id, ExtractionsTable.scrapeId),
          )
          .where(
            and(
              eq(ExtractionsTable.status, "running"),
              lt(ExtractionsTable.startedAt, DateTime.toDateUtc(before)),
            ),
          )
          .orderBy(asc(ExtractionsTable.startedAt), asc(ExtractionsTable.id)),
      ),
    )
  })

  const listByScrape = Effect.fn("ExtractionsRepo.listByScrape", {
    level: "Debug",
  })(function* (scrapeId: ScrapeId) {
    return yield* Rows.decodeAll(Extraction.Info)(
      yield* query(
        db
          .select()
          .from(ExtractionsTable)
          .where(eq(ExtractionsTable.scrapeId, scrapeId))
          .orderBy(asc(ExtractionsTable.attempt)),
      ),
    )
  })

  const latestSuccessful = Effect.fn("ExtractionsRepo.latestSuccessful", {
    level: "Debug",
  })(function* (scrapeId: ScrapeId) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(ExtractionsTable)
          .where(
            and(
              eq(ExtractionsTable.scrapeId, scrapeId),
              eq(ExtractionsTable.status, "success"),
            ),
          )
          .orderBy(desc(ExtractionsTable.attempt))
          .limit(1),
      ),
    )
  })

  const latestExtractedData = Effect.fn("ExtractionsRepo.latestExtractedData", {
    level: "Debug",
  })(function* (parent: Scrape.Parent) {
    const rows = yield* query(
      dataQuery(
        db,
        Predicate.isTagged(parent, "Listing")
          ? eq(ScrapesTable.listingId, parent.listingId)
          : eq(ScrapesTable.pageId, parent.pageId),
      ),
    )

    return rows[0] === undefined
      ? Option.none()
      : Option.some(yield* decodeData(parent, rows[0]))
  })

  const latestExtractedDataForProduct = Effect.fn(
    "ExtractionsRepo.latestExtractedDataForProduct",
    { level: "Debug" },
  )(function* (productId: ProductId) {
    const latest = dataQuery(
      db,
      eq(ScrapesTable.listingId, ListingsTable.id),
    ).as("latest")

    const rows = yield* query(
      db
        .select({
          listingId: ListingsTable.id,
          latest: {
            scrapeId: latest.scrapeId,
            fetchedAt: latest.fetchedAt,
            extractionId: latest.extractionId,
            extractedAt: latest.extractedAt,
            prompt: latest.prompt,
            model: latest.model,
            data: latest.data,
          },
        })
        .from(ListingsTable)
        .innerJoinLateral(latest, sql`true`)
        .where(eq(ListingsTable.productId, productId))
        .orderBy(asc(ListingsTable.createdAt), asc(ListingsTable.id)),
    )

    return yield* Effect.forEach(rows, (row) =>
      decodeData(
        Scrape.Parent.members[0].make({
          listingId: Schema.decodeSync(ListingId)(row.listingId),
        }),
        row.latest,
      ),
    )
  })

  /** One snapshot of the newest successful Scrape and latest successful Extraction per Parent. */
  const bulkCandidates = Effect.fn("ExtractionsRepo.bulkCandidates", {
    level: "Debug",
  })(function* (
    retailerId: RetailerId,
    promptKind: PromptKind,
    prompt: string,
    model: string,
  ) {
    const parents = promptKind === "listing" ? ListingsTable : PagesTable

    const newest = db
      .select({
        id: ScrapesTable.id,
        rootSpanId: ScrapesTable.rootSpanId,
        htmlR2Key: ScrapesTable.htmlR2Key,
      })
      .from(ScrapesTable)
      .where(
        and(
          promptKind === "listing"
            ? eq(ScrapesTable.listingId, parents.id)
            : eq(ScrapesTable.pageId, parents.id),
          eq(ScrapesTable.status, "success"),
        ),
      )
      .orderBy(desc(ScrapesTable.createdAt), desc(ScrapesTable.id))
      .limit(1)
      .as("newest")

    const last = db
      .select({
        prompt: ExtractionsTable.promptSnapshot,
        model: ExtractionsTable.model,
      })
      .from(ExtractionsTable)
      .where(
        and(
          eq(ExtractionsTable.scrapeId, newest.id),
          eq(ExtractionsTable.status, "success"),
        ),
      )
      .orderBy(desc(ExtractionsTable.attempt))
      .limit(1)
      .as("last")

    const rows = yield* query(
      db
        .select({
          scrapeId: newest.id,
          rootSpanId: newest.rootSpanId,
          hasHtml: sql<boolean>`${newest.htmlR2Key} IS NOT NULL`,
          matching: sql<boolean>`(${last.prompt} IS NOT DISTINCT FROM ${prompt} AND ${last.model} IS NOT DISTINCT FROM ${model})`,
        })
        .from(parents)
        .innerJoinLateral(newest, sql`true`)
        .leftJoinLateral(last, sql`true`)
        .where(eq(parents.retailerId, retailerId))
        .orderBy(asc(parents.createdAt), asc(parents.id)),
    )

    return yield* Rows.decodeAll(
      Schema.Struct({
        scrapeId: ScrapeId,
        rootSpanId: Execution.SpanId,
        hasHtml: Schema.Boolean,
        matching: Schema.Boolean,
      }),
    )(rows).pipe(
      Effect.map((rows) => rows.map((row) => ({ ...row, promptKind }))),
    )
  })

  /**
   * One page of Extractions, newest first, over the same `(created_at, id)`
   * keyset the Scrape list uses; one extra row answers whether more remain.
   */
  const list = Effect.fn("ExtractionsRepo.list", { level: "Debug" })(
    function* (options: {
      readonly scrapeId?: ScrapeId | undefined
      readonly status?: ExtractionStatus | undefined
      readonly cursor?: Cursor | undefined
      readonly limit: number
    }) {
      const rows = yield* Rows.decodeAll(Extraction.Info)(
        yield* query(
          db
            .select()
            .from(ExtractionsTable)
            .where(
              and(
                options.scrapeId === undefined
                  ? undefined
                  : eq(ExtractionsTable.scrapeId, options.scrapeId),
                options.status === undefined
                  ? undefined
                  : eq(ExtractionsTable.status, options.status),
                beforeCursor(
                  ExtractionsTable.createdAt,
                  ExtractionsTable.id,
                  options.cursor,
                ),
              ),
            )
            .orderBy(
              desc(ExtractionsTable.createdAt),
              desc(ExtractionsTable.id),
            )
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
    insert,
    findPending,
    findInitial,
    find,
    get,
    allocate,
    findInFlight,
    transition,
    listPending,
    listStuck,
    listByScrape,
    latestSuccessful,
    latestExtractedData,
    latestExtractedDataForProduct,
    bulkCandidates,
    list,
  } as const
})

export const layer = Layer.effect(Service, make)

export class MissingExtraction extends Data.TaggedError("MissingExtraction")<{
  readonly extractionId: ExtractionId
}> {}
