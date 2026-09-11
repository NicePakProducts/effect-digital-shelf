import { RetailerNotFound } from "@digital-shelf/domain/Catalog/Errors"
import {
  Retailer,
  RetailerInsert,
  RetailerUpdate,
  type RetailerDomain,
} from "@digital-shelf/domain/Catalog/Retailer"
import type { RetailerId } from "@digital-shelf/domain/Shared/Ids"
import { retailers } from "@digital-shelf/domain/Sql/Catalog"
import { asc, eq } from "drizzle-orm"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../../Sql/Db.ts"
import { onUniqueViolation, query } from "../../Sql/Errors.ts"
import * as Rows from "../../Sql/Rows.ts"

/**
 * Retailer rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `RetailerNotFound`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

export class DomainTaken extends Data.TaggedError("DomainTaken") {}

const one = Rows.decodeOptional(Retailer)

const all = Rows.decodeAll(Retailer)

const exactlyOne = Rows.decodeOne(Retailer)

const toRow = Rows.encode(RetailerInsert)

const toPatch = Rows.encode(RetailerUpdate)

const orNotFound =
  (id: RetailerId) =>
  <R>(
    self: Effect.Effect<Option.Option<Retailer>, SqlError, R>,
  ): Effect.Effect<Retailer, RetailerNotFound | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new RetailerNotFound({ retailerId: id })),
        onSome: Effect.succeed,
      }),
    )

export const find = Effect.fn("RetailersRepo.find")(function* (id: RetailerId) {
  const db = yield* Db

  return yield* one(
    yield* query(db.select().from(retailers).where(eq(retailers.id, id))),
  )
})

export const get = (id: RetailerId) => find(id).pipe(orNotFound(id))

/**
 * The Retailer row under a lock, so the host rule cannot be checked against a
 * domain another transaction is changing. `FOR SHARE` is the child writes'
 * read (many Listings and Pages may be written at once); `FOR UPDATE` is the
 * domain change's, which must exclude them while it inspects their URLs.
 */
const locked = (strength: "share" | "update") =>
  Effect.fn(`RetailersRepo.get.for.${strength}`)(function* (id: RetailerId) {
    const db = yield* Db

    return yield* one(
      yield* query(
        db.select().from(retailers).where(eq(retailers.id, id)).for(strength),
      ),
    ).pipe(orNotFound(id))
  })

export const getForShare = locked("share")

export const getForUpdate = locked("update")

export const list = Effect.fn("RetailersRepo.list")(function* () {
  const db = yield* Db

  return yield* all(
    yield* query(
      db
        .select()
        .from(retailers)
        .orderBy(asc(retailers.name), asc(retailers.createdAt)),
    ),
  )
})

export const insert = Effect.fn("RetailersRepo.insert")(function* (
  retailer: RetailerInsert,
) {
  const db = yield* Db

  return yield* exactlyOne(
    yield* query(db.insert(retailers).values(toRow(retailer)).returning()).pipe(
      onUniqueViolation("retailers_domain", () => new DomainTaken()),
    ),
  )
})

export const update = Effect.fn("RetailersRepo.update")(function* (
  id: RetailerId,
  patch: RetailerUpdate,
) {
  const values = toPatch(patch)

  if (Object.keys(values).length === 0) return yield* get(id)
  const db = yield* Db

  return yield* one(
    yield* query(
      db.update(retailers).set(values).where(eq(retailers.id, id)).returning(),
    ).pipe(onUniqueViolation("retailers_domain", () => new DomainTaken())),
  ).pipe(orNotFound(id))
})

/** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
export const remove = Effect.fn("RetailersRepo.remove")(function* (
  id: RetailerId,
) {
  const db = yield* Db

  return yield* one(
    yield* query(db.delete(retailers).where(eq(retailers.id, id)).returning()),
  ).pipe(orNotFound(id))
})

export const findByDomain = Effect.fn("RetailersRepo.findByDomain")(function* (
  domain: RetailerDomain,
) {
  const db = yield* Db

  return yield* one(
    yield* query(
      db.select().from(retailers).where(eq(retailers.domain, domain)),
    ),
  )
})
