import { ListingsTable } from "@app/db/schema/listings"
import { PagesTable } from "@app/db/schema/pages"
import { ListingId, PageId, type RetailerId } from "@app/schema/ids"
import { Url } from "@app/schema/refine"
import * as Schema from "effect/Schema"
import { Retailer } from "@app/schema/retailer"
import { RetailersTable } from "@app/db/schema/retailers"
import { asc, eq } from "drizzle-orm"
import * as Data from "effect/Data"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "@app/db"
import { onUniqueViolation, query } from "../Sql/Errors"
import * as Rows from "../Sql/Rows"
/**
 * Retailer rows. `find` returns an Option; `get`, `update` and `remove` fail with
 * `MissingRetailer`. Repositories never open a transaction: the feature that
 * calls them does, and these queries join it through the fiber.
 */

export class DomainTaken extends Data.TaggedError("DomainTaken") {}

const one = Rows.decodeOptional(Retailer.Info)

const all = Rows.decodeAll(Retailer.Info)

const exactlyOne = Rows.decodeOne(Retailer.Info)

const toRow = Rows.encode(Retailer.Insert)

const toPatch = Rows.encode(Retailer.UpdateRow)

const orNotFound =
  (id: RetailerId) =>
  <R>(
    self: Effect.Effect<Option.Option<Retailer.Info>, SqlError, R>,
  ): Effect.Effect<Retailer.Info, MissingRetailer | SqlError, R> =>
    Effect.flatMap(
      self,
      Option.match({
        onNone: () => Effect.fail(new MissingRetailer({ retailerId: id })),
        onSome: Effect.succeed,
      }),
    )

export * as RetailersRepo from "./repository"

export interface Interface {
  readonly listingUrls: (
    id: RetailerId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: ListingId; readonly url: string }>,
    SqlError
  >
  readonly pageUrls: (
    id: RetailerId,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: PageId; readonly url: string }>,
    SqlError
  >
  readonly find: (
    id: RetailerId,
  ) => Effect.Effect<Option.Option<Retailer.Info>, SqlError>
  readonly get: (
    id: RetailerId,
  ) => Effect.Effect<Retailer.Info, MissingRetailer | SqlError>
  readonly list: Effect.Effect<ReadonlyArray<Retailer.Info>, SqlError>
  readonly insert: (
    retailer: Retailer.Insert,
  ) => Effect.Effect<Retailer.Info, SqlError | DomainTaken>
  readonly update: (
    id: RetailerId,
    patch: Retailer.UpdateRow,
  ) => Effect.Effect<Retailer.Info, MissingRetailer | SqlError | DomainTaken>
  readonly remove: (
    id: RetailerId,
  ) => Effect.Effect<Retailer.Info, MissingRetailer | SqlError>
  readonly getForShare: (
    id: RetailerId,
  ) => Effect.Effect<Retailer.Info, MissingRetailer | SqlError>
  readonly getForUpdate: (
    id: RetailerId,
  ) => Effect.Effect<Retailer.Info, MissingRetailer | SqlError>
  readonly findByDomain: (
    domain: Retailer.Domain,
  ) => Effect.Effect<Option.Option<Retailer.Info>, SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/retailers/repository",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db

  // Domain changes inspect children under the Retailer FOR UPDATE lock.
  const listingUrls = (id: RetailerId) =>
    query(
      db
        .select({ id: ListingsTable.id, url: ListingsTable.url })
        .from(ListingsTable)
        .where(eq(ListingsTable.retailerId, id))
        .orderBy(asc(ListingsTable.createdAt), asc(ListingsTable.id)),
    ).pipe(
      Effect.flatMap(
        Rows.decodeAll(Schema.Struct({ id: ListingId, url: Url })),
      ),
    )

  const pageUrls = (id: RetailerId) =>
    query(
      db
        .select({ id: PagesTable.id, url: PagesTable.url })
        .from(PagesTable)
        .where(eq(PagesTable.retailerId, id))
        .orderBy(asc(PagesTable.createdAt), asc(PagesTable.id)),
    ).pipe(
      Effect.flatMap(Rows.decodeAll(Schema.Struct({ id: PageId, url: Url }))),
    )

  const find = Effect.fn("RetailersRepo.find", { level: "Debug" })(function* (
    id: RetailerId,
  ) {
    return yield* one(
      yield* query(
        db.select().from(RetailersTable).where(eq(RetailersTable.id, id)),
      ),
    )
  })

  const get = (id: RetailerId) => find(id).pipe(orNotFound(id))

  /**
   * The Retailer row under a lock, so the host rule cannot be checked against a
   * domain another transaction is changing. `FOR SHARE` is the child writes'
   * read (many Listings and Pages may be written at once); `FOR UPDATE` is the
   * domain change's, which must exclude them while it inspects their URLs.
   */
  const locked = (strength: "share" | "update") =>
    Effect.fn(`RetailersRepo.get.for.${strength}`, { level: "Debug" })(
      function* (id: RetailerId) {
        return yield* one(
          yield* query(
            db
              .select()
              .from(RetailersTable)
              .where(eq(RetailersTable.id, id))
              .for(strength),
          ),
        ).pipe(orNotFound(id))
      },
    )

  const getForShare = locked("share")

  const getForUpdate = locked("update")

  const list = Effect.fn("RetailersRepo.list", { level: "Debug" })(
    function* () {
      return yield* all(
        yield* query(
          db
            .select()
            .from(RetailersTable)
            .orderBy(asc(RetailersTable.name), asc(RetailersTable.createdAt)),
        ),
      )
    },
  )()

  const insert = Effect.fn("RetailersRepo.insert", { level: "Debug" })(
    function* (retailer: Retailer.Insert) {
      return yield* exactlyOne(
        yield* query(
          db.insert(RetailersTable).values(toRow(retailer)).returning(),
        ).pipe(onUniqueViolation("retailers_domain", () => new DomainTaken())),
      )
    },
  )

  const update = Effect.fn("RetailersRepo.update", { level: "Debug" })(
    function* (id: RetailerId, patch: Retailer.UpdateRow) {
      const values = toPatch(patch)

      if (Object.keys(values).length === 0) return yield* get(id)

      return yield* one(
        yield* query(
          db
            .update(RetailersTable)
            .set(values)
            .where(eq(RetailersTable.id, id))
            .returning(),
        ).pipe(onUniqueViolation("retailers_domain", () => new DomainTaken())),
      ).pipe(orNotFound(id))
    },
  )

  /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
  const remove = Effect.fn("RetailersRepo.remove", { level: "Debug" })(
    function* (id: RetailerId) {
      return yield* one(
        yield* query(
          db
            .delete(RetailersTable)
            .where(eq(RetailersTable.id, id))
            .returning(),
        ),
      ).pipe(orNotFound(id))
    },
  )

  const findByDomain = Effect.fn("RetailersRepo.findByDomain", {
    level: "Debug",
  })(function* (domain: Retailer.Domain) {
    return yield* one(
      yield* query(
        db
          .select()
          .from(RetailersTable)
          .where(eq(RetailersTable.domain, domain)),
      ),
    )
  })

  return {
    listingUrls,
    pageUrls,
    find,
    get,
    getForShare,
    getForUpdate,
    list,
    insert,
    update,
    remove,
    findByDomain,
  } as const
})

export const layer = Layer.effect(Service, make)

export class MissingRetailer extends Data.TaggedError("MissingRetailer")<{
  readonly retailerId: RetailerId
}> {}
