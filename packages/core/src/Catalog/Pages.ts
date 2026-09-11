import {
  type RetailerNotFound,
  type BrandNotFound,
  type UrlHostMismatch,
  PageNotFound,
  PageAlreadyExists,
} from "@digital-shelf/domain/Catalog/Errors"
import type { PageWithStatus } from "@digital-shelf/domain/Catalog/Page"
import type { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import { defaultCadence } from "@digital-shelf/domain/Catalog/Cadence"
import type {
  CreatePage,
  GetPageInput,
  RemovePageInput,
  UpdatePageInput,
  PageImpactInput,
} from "@digital-shelf/domain/Catalog/PageManagement"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import { requireHostMatch } from "./HostRule.ts"
import { PagesRepo, type Filter } from "./repositories/PagesRepo.ts"
import { BrandsRepo } from "./repositories/BrandsRepo.ts"
import { RetailersRepo } from "./repositories/RetailersRepo.ts"

export class Pages extends Context.Service<
  Pages,
  {
    readonly create: (
      command: CreatePage,
    ) => Effect.Effect<
      PageWithStatus,
      | BrandNotFound
      | RetailerNotFound
      | UrlHostMismatch
      | PageAlreadyExists
      | SqlError
    >
    readonly update: (
      input: UpdatePageInput,
    ) => Effect.Effect<
      PageWithStatus,
      PageNotFound | UrlHostMismatch | SqlError
    >
    readonly get: (
      input: GetPageInput,
    ) => Effect.Effect<PageWithStatus, PageNotFound | SqlError>
    readonly list: (
      filter?: Filter,
    ) => Effect.Effect<ReadonlyArray<PageWithStatus>, SqlError>
    readonly remove: (
      input: RemovePageInput,
    ) => Effect.Effect<CascadeImpact, PageNotFound | SqlError>
    readonly impact: (
      input: PageImpactInput,
    ) => Effect.Effect<CascadeImpact, PageNotFound | SqlError>
  }
>()("@digital-shelf/core/Catalog/Pages", {
  make: Effect.gen(function* () {
    const db = yield* Db
    const cascade = yield* Cascade
    const repo = yield* PagesRepo
    const brandsRepo = yield* BrandsRepo
    const retailersRepo = yield* RetailersRepo

    const get = Effect.fn("Pages.get")(function* (input: GetPageInput) {
      const row = yield* repo.findWithStatus(input.pageId)

      return yield* Option.match(row, {
        onNone: () => Effect.fail(new PageNotFound({ pageId: input.pageId })),
        onSome: Effect.succeed,
      })
    })

    const create = Effect.fn("Pages.create")(function* (command: CreatePage) {
      const insert = db.transaction(() =>
        Effect.gen(function* () {
          yield* brandsRepo.get(command.brandId)
          const retailer = yield* retailersRepo.getForShare(command.retailerId)
          yield* requireHostMatch(command.url, retailer.domain)

          const row = yield* repo.insert({
            ...command,
            cadence: command.cadence ?? defaultCadence,
            paused: command.paused ?? false,
          })

          return yield* Option.match(yield* repo.findWithStatus(row.id), {
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
          const holder = yield* repo.findByBrandAndRetailer(
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
            const holder = yield* repo.findByBrandAndRetailer(
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
    })

    const update = Effect.fn("Pages.update")(function* (
      input: UpdatePageInput,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          if (input.command.url !== undefined) {
            const row = yield* repo.get(input.pageId)

            // The foreign key guarantees the Retailer: its absence is a defect.
            const retailer = yield* retailersRepo
              .getForShare(row.retailerId)
              .pipe(Effect.catchTag("RetailerNotFound", Effect.die))

            yield* requireHostMatch(input.command.url, retailer.domain)
          }

          yield* repo.update(input.pageId, input.command)

          return yield* get({ pageId: input.pageId })
        }),
      )
    })

    const list = Effect.fn("Pages.list")(function* (filter: Filter = {}) {
      return yield* repo.listWithStatus(filter)
    })

    const impact = Effect.fn("Pages.impact")(function* (
      input: PageImpactInput,
    ) {
      yield* repo.get(input.pageId)

      return yield* cascade.impact(CascadeRoot.Page({ id: input.pageId }))
    })

    const remove = Effect.fn("Pages.remove")(function* (
      input: RemovePageInput,
    ) {
      return (yield* cascade.remove(
        CascadeRoot.Page({ id: input.pageId }),
        repo.remove(input.pageId),
      )).impact
    })

    return { create, update, get, list, impact, remove }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([PagesRepo.layer, BrandsRepo.layer, RetailersRepo.layer]),
  )
}
