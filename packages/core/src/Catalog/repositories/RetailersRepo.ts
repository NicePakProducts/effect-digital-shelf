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
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
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

export class RetailersRepo extends Context.Service<
  RetailersRepo,
  {
    readonly find: (
      id: RetailerId,
    ) => Effect.Effect<Option.Option<Retailer>, SqlError>
    readonly get: (
      id: RetailerId,
    ) => Effect.Effect<Retailer, RetailerNotFound | SqlError>
    readonly list: Effect.Effect<ReadonlyArray<Retailer>, SqlError>
    readonly insert: (
      retailer: RetailerInsert,
    ) => Effect.Effect<Retailer, SqlError | DomainTaken>
    readonly update: (
      id: RetailerId,
      patch: RetailerUpdate,
    ) => Effect.Effect<Retailer, RetailerNotFound | SqlError | DomainTaken>
    readonly remove: (
      id: RetailerId,
    ) => Effect.Effect<Retailer, RetailerNotFound | SqlError>
    readonly getForShare: (
      id: RetailerId,
    ) => Effect.Effect<Retailer, RetailerNotFound | SqlError>
    readonly getForUpdate: (
      id: RetailerId,
    ) => Effect.Effect<Retailer, RetailerNotFound | SqlError>
    readonly findByDomain: (
      domain: RetailerDomain,
    ) => Effect.Effect<Option.Option<Retailer>, SqlError>
  }
>()("@digital-shelf/core/Catalog/repositories/RetailersRepo", {
  make: Effect.gen(function* () {
    const db = yield* Db

    const find = Effect.fn("RetailersRepo.find", { level: "Debug" })(function* (
      id: RetailerId,
    ) {
      return yield* one(
        yield* query(db.select().from(retailers).where(eq(retailers.id, id))),
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
                .from(retailers)
                .where(eq(retailers.id, id))
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
              .from(retailers)
              .orderBy(asc(retailers.name), asc(retailers.createdAt)),
          ),
        )
      },
    )()

    const insert = Effect.fn("RetailersRepo.insert", { level: "Debug" })(
      function* (retailer: RetailerInsert) {
        return yield* exactlyOne(
          yield* query(
            db.insert(retailers).values(toRow(retailer)).returning(),
          ).pipe(
            onUniqueViolation("retailers_domain", () => new DomainTaken()),
          ),
        )
      },
    )

    const update = Effect.fn("RetailersRepo.update", { level: "Debug" })(
      function* (id: RetailerId, patch: RetailerUpdate) {
        const values = toPatch(patch)

        if (Object.keys(values).length === 0) return yield* get(id)

        return yield* one(
          yield* query(
            db
              .update(retailers)
              .set(values)
              .where(eq(retailers.id, id))
              .returning(),
          ).pipe(
            onUniqueViolation("retailers_domain", () => new DomainTaken()),
          ),
        ).pipe(orNotFound(id))
      },
    )

    /** The raw row delete; Catalog/Cascade collects what the cascade drops first. */
    const remove = Effect.fn("RetailersRepo.remove", { level: "Debug" })(
      function* (id: RetailerId) {
        return yield* one(
          yield* query(
            db.delete(retailers).where(eq(retailers.id, id)).returning(),
          ),
        ).pipe(orNotFound(id))
      },
    )

    const findByDomain = Effect.fn("RetailersRepo.findByDomain", {
      level: "Debug",
    })(function* (domain: RetailerDomain) {
      return yield* one(
        yield* query(
          db.select().from(retailers).where(eq(retailers.domain, domain)),
        ),
      )
    })

    return {
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
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
