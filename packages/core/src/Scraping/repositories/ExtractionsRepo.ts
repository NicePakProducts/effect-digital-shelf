import * as Predicate from "effect/Predicate"
import { SpanId } from "@digital-shelf/domain/Scraping/Execution"
import { ExtractionNotFound } from "@digital-shelf/domain/Scraping/Errors"
import { LatestExtractedData } from "@digital-shelf/domain/Scraping/LatestExtractedData"
import { ScrapeParent } from "@digital-shelf/domain/Scraping/Scrape"
import type {
  ExtractionStatus,
  PromptKind,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import { listings, pages, retailers } from "@digital-shelf/domain/Sql/Catalog"
import * as DateTime from "effect/DateTime"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  Extraction,
  ExtractionInsert,
  ExtractionUpdate,
} from "@digital-shelf/domain/Scraping/Extraction"
import {
  ScrapeId,
  ExtractionId,
  ListingId,
  type ProductId,
  type RetailerId,
} from "@digital-shelf/domain/Shared/Ids"
import { extractions, scrapes } from "@digital-shelf/domain/Sql/Scraping"
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
import { Db } from "../../Sql/Db.ts"
import { query } from "../../Sql/Errors.ts"
import { beforeCursor, type Cursor } from "../../Sql/Keyset.ts"
import * as Rows from "../../Sql/Rows.ts"

/** Extraction queries and conditional writes; features own transactions. */

const one = Rows.decodeOptional(Extraction)

const exactlyOne = Rows.decodeOne(Extraction)

const toRow = Rows.encode(ExtractionInsert)

export const insert = Effect.fn("ExtractionsRepo.insert", { level: "Debug" })(
  function* (extraction: ExtractionInsert) {
    const db = yield* Db

    return yield* exactlyOne(
      yield* query(
        db.insert(extractions).values(toRow(extraction)).returning(),
      ),
    )
  },
)

/** The Scrape's `pending` Extraction, if any (at most one by index). */
export const findPending = Effect.fn("ExtractionsRepo.findPending", {
  level: "Debug",
})(function* (scrapeId: ScrapeId) {
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

/** Attempt one remains the replay result even after Extraction progresses. */
export const findInitial = Effect.fn("ExtractionsRepo.findInitial", {
  level: "Debug",
})(function* (scrapeId: ScrapeId) {
  const db = yield* Db

  return yield* one(
    yield* query(
      db
        .select()
        .from(extractions)
        .where(
          and(eq(extractions.scrapeId, scrapeId), eq(extractions.attempt, 1)),
        ),
    ),
  )
})

export const find = Effect.fn("ExtractionsRepo.find", { level: "Debug" })(
  function* (id: ExtractionId) {
    const db = yield* Db

    return yield* one(
      yield* query(db.select().from(extractions).where(eq(extractions.id, id))),
    )
  },
)

export const get = (id: ExtractionId) =>
  find(id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new ExtractionNotFound({ extractionId: id })),
        onSome: Effect.succeed,
      }),
    ),
  )

/** Allocation and both race backstops run in one statement. */
export const allocate = Effect.fn("ExtractionsRepo.allocate", {
  level: "Debug",
})(function* (
  values: Omit<ExtractionInsert, "attempt">,
  options: { tolerateConflict: boolean },
) {
  const db = yield* Db
  const now = yield* DateTime.now

  const encoded = toRow({
    ...values,
    attempt: 1,
    id:
      values.id ??
      (yield* Schema.decodeEffect(ExtractionId)(crypto.randomUUID()).pipe(
        Effect.orDie,
      )),
    createdAt: values.createdAt ?? now,
    updatedAt: values.updatedAt ?? now,
  })

  // SAFETY: Both columns and encoded fields derive from the extractions table; missing optional insert values intentionally become SQL NULL.
  const fields = Object.entries(getTableColumns(extractions)).map(
    ([key, column]) =>
      key === "attempt"
        ? sql`coalesce(max(${extractions.attempt}), 0) + 1`
        : sql`${sql.param(encoded[key as keyof typeof encoded] ?? null, column)}`,
  )

  const statement = db
    .insert(extractions)
    .select(
      sql`SELECT ${sql.join(fields, sql`, `)} FROM ${extractions} WHERE ${extractions.scrapeId} = ${values.scrapeId}`,
    )

  return yield* one(
    yield* query(
      options.tolerateConflict
        ? statement.onConflictDoNothing().returning()
        : statement.returning(),
    ),
  )
})

export const findInFlight = Effect.fn("ExtractionsRepo.findInFlight", {
  level: "Debug",
})(function* (scrapeId: ScrapeId) {
  const db = yield* Db

  return yield* one(
    yield* query(
      db
        .select()
        .from(extractions)
        .where(
          and(
            eq(extractions.scrapeId, scrapeId),
            inArray(extractions.status, ["pending", "running"]),
          ),
        )
        .limit(1),
    ),
  )
})

export const transition = Effect.fn("ExtractionsRepo.transition", {
  level: "Debug",
})(function* (
  id: ExtractionId,
  from: ExtractionStatus,
  to: ExtractionStatus,
  patch: ExtractionUpdate,
) {
  const db = yield* Db

  return yield* one(
    yield* query(
      db
        .update(extractions)
        .set({ ...Rows.encode(ExtractionUpdate)(patch), status: to })
        .where(and(eq(extractions.id, id), eq(extractions.status, from)))
        .returning(),
    ),
  )
})

export const TracedExtraction = Schema.Struct({
  ...Extraction.fields,
  rootSpanId: SpanId,
})

export const listPending = Effect.fn("ExtractionsRepo.listPending", {
  level: "Debug",
})(function* (limit: number) {
  if (limit <= 0) return []
  const db = yield* Db

  return yield* Rows.decodeAll(TracedExtraction)(
    yield* query(
      db
        .select({
          ...getTableColumns(extractions),
          rootSpanId: scrapes.rootSpanId,
        })
        .from(extractions)
        .innerJoin(scrapes, eq(scrapes.id, extractions.scrapeId))
        .where(eq(extractions.status, "pending"))
        .orderBy(asc(extractions.createdAt), asc(extractions.id))
        .limit(limit),
    ),
  )
})

export const listStuck = Effect.fn("ExtractionsRepo.listStuck", {
  level: "Debug",
})(function* (before: DateTime.Utc) {
  const db = yield* Db

  return yield* Rows.decodeAll(TracedExtraction)(
    yield* query(
      db
        .select({
          ...getTableColumns(extractions),
          rootSpanId: scrapes.rootSpanId,
        })
        .from(extractions)
        .innerJoin(scrapes, eq(scrapes.id, extractions.scrapeId))
        .where(
          and(
            eq(extractions.status, "running"),
            lt(extractions.startedAt, DateTime.toDateUtc(before)),
          ),
        )
        .orderBy(asc(extractions.startedAt), asc(extractions.id)),
    ),
  )
})

export const listByScrape = Effect.fn("ExtractionsRepo.listByScrape", {
  level: "Debug",
})(function* (scrapeId: ScrapeId) {
  const db = yield* Db

  return yield* Rows.decodeAll(Extraction)(
    yield* query(
      db
        .select()
        .from(extractions)
        .where(eq(extractions.scrapeId, scrapeId))
        .orderBy(asc(extractions.attempt)),
    ),
  )
})

export const latestSuccessful = Effect.fn("ExtractionsRepo.latestSuccessful", {
  level: "Debug",
})(function* (scrapeId: ScrapeId) {
  const db = yield* Db

  return yield* one(
    yield* query(
      db
        .select()
        .from(extractions)
        .where(
          and(
            eq(extractions.scrapeId, scrapeId),
            eq(extractions.status, "success"),
          ),
        )
        .orderBy(desc(extractions.attempt))
        .limit(1),
    ),
  )
})

const dataColumns = {
  scrapeId: sql`${scrapes.id}`.mapWith(scrapes.id).as("scrape_id"),
  fetchedAt: sql`${scrapes.finishedAt}`
    .mapWith(scrapes.finishedAt)
    .as("fetched_at"),
  extractionId: sql`${extractions.id}`
    .mapWith(extractions.id)
    .as("extraction_id"),
  extractedAt: sql`${extractions.finishedAt}`
    .mapWith(extractions.finishedAt)
    .as("extracted_at"),
  prompt: extractions.promptSnapshot,
  model: extractions.model,
  data: extractions.extractedJson,
}

const dataQuery = (db: Db["Service"], condition: SQL) =>
  db
    .select(dataColumns)
    .from(scrapes)
    .innerJoin(
      extractions,
      and(
        eq(extractions.scrapeId, scrapes.id),
        eq(extractions.status, "success"),
      ),
    )
    .where(condition)
    .orderBy(
      desc(scrapes.createdAt),
      desc(scrapes.id),
      desc(extractions.attempt),
    )
    .limit(1)

const decodeData = (
  parent: ScrapeParent,
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
  Schema.decodeUnknownEffect(LatestExtractedData)({
    parent,
    data: row.data,
    provenance: row,
  }).pipe(Effect.orDie)

export const latestExtractedData = Effect.fn(
  "ExtractionsRepo.latestExtractedData",
  { level: "Debug" },
)(function* (parent: ScrapeParent) {
  const db = yield* Db

  const rows = yield* query(
    dataQuery(
      db,
      Predicate.isTagged(parent, "Listing")
        ? eq(scrapes.listingId, parent.listingId)
        : eq(scrapes.pageId, parent.pageId),
    ),
  )

  return rows[0] === undefined
    ? Option.none()
    : Option.some(yield* decodeData(parent, rows[0]))
})

export const latestExtractedDataForProduct = Effect.fn(
  "ExtractionsRepo.latestExtractedDataForProduct",
  { level: "Debug" },
)(function* (productId: ProductId) {
  const db = yield* Db
  const latest = dataQuery(db, eq(scrapes.listingId, listings.id)).as("latest")

  const rows = yield* query(
    db
      .select({
        listingId: listings.id,
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
      .from(listings)
      .innerJoinLateral(latest, sql`true`)
      .where(eq(listings.productId, productId))
      .orderBy(asc(listings.createdAt), asc(listings.id)),
  )

  return yield* Effect.forEach(rows, (row) =>
    decodeData(
      ScrapeParent.members[0].make({
        listingId: Schema.decodeSync(ListingId)(row.listingId),
      }),
      row.latest,
    ),
  )
})

/** One snapshot of the newest successful Scrape and latest successful Extraction per Parent. */
export const bulkCandidates = Effect.fn("ExtractionsRepo.bulkCandidates", {
  level: "Debug",
})(function* (
  retailerId: RetailerId,
  promptKind: PromptKind,
  prompt: string,
  model: string,
) {
  const db = yield* Db
  const parents = promptKind === "listing" ? listings : pages

  const newest = db
    .select({
      id: scrapes.id,
      rootSpanId: scrapes.rootSpanId,
      htmlR2Key: scrapes.htmlR2Key,
    })
    .from(scrapes)
    .where(
      and(
        promptKind === "listing"
          ? eq(scrapes.listingId, parents.id)
          : eq(scrapes.pageId, parents.id),
        eq(scrapes.status, "success"),
      ),
    )
    .orderBy(desc(scrapes.createdAt), desc(scrapes.id))
    .limit(1)
    .as("newest")

  const last = db
    .select({ prompt: extractions.promptSnapshot, model: extractions.model })
    .from(extractions)
    .where(
      and(
        eq(extractions.scrapeId, newest.id),
        eq(extractions.status, "success"),
      ),
    )
    .orderBy(desc(extractions.attempt))
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
      rootSpanId: SpanId,
      hasHtml: Schema.Boolean,
      matching: Schema.Boolean,
    }),
  )(rows).pipe(
    Effect.map((rows) => rows.map((row) => ({ ...row, promptKind }))),
  )
})

export const retailerPrompt = Effect.fn("ExtractionsRepo.retailerPrompt", {
  level: "Debug",
})(function* (retailerId: RetailerId, kind: PromptKind) {
  const db = yield* Db

  const rows = yield* query(
    db
      .select({
        prompt:
          kind === "listing"
            ? retailers.listingExtractPrompt
            : retailers.pageExtractPrompt,
      })
      .from(retailers)
      .where(eq(retailers.id, retailerId)),
  )

  return Option.fromUndefinedOr(rows[0]?.prompt)
})

/**
 * One page of Extractions, newest first, over the same `(created_at, id)`
 * keyset the Scrape list uses; one extra row answers whether more remain.
 */
export const list = Effect.fn("ExtractionsRepo.list", { level: "Debug" })(
  function* (options: {
    readonly scrapeId?: ScrapeId | undefined
    readonly status?: ExtractionStatus | undefined
    readonly cursor?: Cursor | undefined
    readonly limit: number
  }) {
    const db = yield* Db

    const rows = yield* Rows.decodeAll(Extraction)(
      yield* query(
        db
          .select()
          .from(extractions)
          .where(
            and(
              options.scrapeId === undefined
                ? undefined
                : eq(extractions.scrapeId, options.scrapeId),
              options.status === undefined
                ? undefined
                : eq(extractions.status, options.status),
              beforeCursor(
                extractions.createdAt,
                extractions.id,
                options.cursor,
              ),
            ),
          )
          .orderBy(desc(extractions.createdAt), desc(extractions.id))
          .limit(options.limit + 1),
      ),
    )

    return {
      items: rows.slice(0, options.limit),
      hasMore: rows.length > options.limit,
    }
  },
)
