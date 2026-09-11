import { defaultCadence } from "@digital-shelf/domain/Catalog/Cadence"
import {
  PageNotFound,
  PageAlreadyExists,
} from "@digital-shelf/domain/Catalog/Errors"
import type {
  CreatePage,
  UpdatePage,
} from "@digital-shelf/domain/Catalog/PageManagement"
import type { PageId } from "@digital-shelf/domain/Shared/Ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import { requireHostMatch } from "./HostRule.ts"
import * as Repo from "./repositories/PagesRepo.ts"
import * as BrandsRepo from "./repositories/BrandsRepo.ts"
import * as RetailersRepo from "./repositories/RetailersRepo.ts"

const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const cascade = yield* Cascade

  const get = Effect.fn("Pages.get")(function* (id: PageId) {
    const row = yield* Repo.findWithStatus(id)

    return yield* Option.match(row, {
      onNone: () => Effect.fail(new PageNotFound({ pageId: id })),
      onSome: Effect.succeed,
    })
  }, withDb)

  const create = Effect.fn("Pages.create")(function* (command: CreatePage) {
    const insert = db.transaction(() =>
      Effect.gen(function* () {
        yield* BrandsRepo.get(command.brandId)
        const retailer = yield* RetailersRepo.getForShare(command.retailerId)
        yield* requireHostMatch(command.url, retailer.domain)

        const row = yield* Repo.insert({
          ...command,
          cadence: command.cadence ?? defaultCadence,
          paused: command.paused ?? false,
        })

        return yield* Option.match(yield* Repo.findWithStatus(row.id), {
          onNone: () =>
            Effect.die(
              new Error(
                "Inserted Page disappeared before its status could be read",
              ),
            ),
          onSome: Effect.succeed,
        })
      }),
    )

    const conflict = () =>
      Effect.gen(function* () {
        // Resolve the holder only after the failed transaction has rolled back.
        const holder = yield* Repo.findByBrandAndRetailer(
          command.brandId,
          command.retailerId,
        )

        if (Option.isNone(holder))
          return yield* Effect.die(
            new Error(
              "Conflicting Page disappeared before it could be identified",
            ),
          )

        return yield* Effect.fail(
          new PageAlreadyExists({
            brandId: command.brandId,
            retailerId: command.retailerId,
            pageId: holder.value.id,
          }),
        )
      })

    return yield* insert.pipe(
      Effect.catchTag("PageTaken", () =>
        Effect.gen(function* () {
          const holder = yield* Repo.findByBrandAndRetailer(
            command.brandId,
            command.retailerId,
          )

          if (Option.isNone(holder))
            return yield* insert.pipe(Effect.catchTag("PageTaken", conflict))

          return yield* Effect.fail(
            new PageAlreadyExists({
              brandId: command.brandId,
              retailerId: command.retailerId,
              pageId: holder.value.id,
            }),
          )
        }),
      ),
    )
  }, withDb)

  const update = Effect.fn("Pages.update")(function* (
    id: PageId,
    command: UpdatePage,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        if (command.url !== undefined) {
          const row = yield* Repo.get(id)

          // The foreign key guarantees the Retailer: its absence is a defect.
          const retailer = yield* RetailersRepo.getForShare(
            row.retailerId,
          ).pipe(Effect.catchTag("RetailerNotFound", Effect.die))

          yield* requireHostMatch(command.url, retailer.domain)
        }

        yield* Repo.update(id, command)

        return yield* get(id)
      }),
    )
  }, withDb)

  const list = Effect.fn("Pages.list")(function* (filter: Repo.Filter = {}) {
    return yield* Repo.listWithStatus(filter).pipe(withDb)
  })

  const impact = Effect.fn("Pages.impact")(function* (id: PageId) {
    yield* Repo.get(id)

    return yield* cascade.impact({ _tag: "Page", id })
  }, withDb)

  const remove = Effect.fn("Pages.remove")(function* (id: PageId) {
    return (yield* cascade.remove({ _tag: "Page", id }, Repo.remove(id))).impact
  }, withDb)

  return { create, update, get, list, impact, remove }
})

export class Pages extends Context.Service<
  Pages,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Catalog/Pages", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
