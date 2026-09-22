import { PagesErrors } from "./pages/errors"
import { BrandsErrors, Brands } from "./brands"
import { RetailersErrors, Retailers, requireHostMatch } from "./retailers"
import type { Page } from "@app/schema/page"
import { type CascadeImpact, CascadeRoot } from "@app/schema/cascade"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { defaultCadence } from "@app/schema/cadence"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Db } from "@app/db"
import { Cascade } from "./cascade"
import { PagesRepo, type Filter } from "./pages/repository"

export * as Pages from "./pages"

export { PagesErrors } from "./pages/errors"

export interface Interface {
  readonly markScraped: (
    input: Page.MarkScrapedInput,
  ) => Effect.Effect<void, SqlError>
  readonly create: (
    command: Page.Create,
  ) => Effect.Effect<
    Page.WithStatus,
    | BrandsErrors.NotFound
    | RetailersErrors.NotFound
    | RetailersErrors.UrlHostMismatch
    | PagesErrors.AlreadyExists
    | SqlError
  >
  readonly update: (
    input: Page.UpdateInput,
  ) => Effect.Effect<
    Page.WithStatus,
    PagesErrors.NotFound | RetailersErrors.UrlHostMismatch | SqlError
  >
  readonly get: (
    input: Page.GetInput,
  ) => Effect.Effect<Page.WithStatus, PagesErrors.NotFound | SqlError>
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Page.WithStatus>, SqlError>
  readonly remove: (
    input: Page.RemoveInput,
  ) => Effect.Effect<CascadeImpact, PagesErrors.NotFound | SqlError>
  readonly impact: (
    input: Page.ImpactInput,
  ) => Effect.Effect<CascadeImpact, PagesErrors.NotFound | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/pages",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db
  const cascade = yield* Cascade.Service
  const repo = yield* PagesRepo.Service
  const brandsRepo = yield* Brands.Service
  const retailersRepo = yield* Retailers.Service

  const get = Effect.fn("Pages.get")(function* (input: Page.GetInput) {
    const row = yield* repo.findWithStatus(input.pageId)

    return yield* Option.match(row, {
      onNone: () =>
        Effect.fail(new PagesErrors.NotFound({ pageId: input.pageId })),
      onSome: Effect.succeed,
    })
  })

  const create = Effect.fn("Pages.create")(function* (command: Page.Create) {
    const insert = db.transaction(() =>
      Effect.gen(function* () {
        yield* brandsRepo.get({ brandId: command.brandId })

        const retailer = yield* retailersRepo.getForShare({
          retailerId: command.retailerId,
        })

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
          new PagesErrors.AlreadyExists({
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
            new PagesErrors.AlreadyExists({
              brandId: command.brandId,
              retailerId: command.retailerId,
              pageId: holder.value.id,
            }),
          )
        }),
      ),
    )
  })

  const update = Effect.fn("Pages.update")(function* (input: Page.UpdateInput) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        if (input.command.url !== undefined) {
          const row = yield* repo
            .get(input.pageId)
            .pipe(
              Effect.catchTag("MissingPage", (error) =>
                Effect.fail(new PagesErrors.NotFound({ pageId: error.pageId })),
              ),
            )

          // The foreign key guarantees the Retailer: its absence is a defect.
          const retailer = yield* retailersRepo
            .getForShare({ retailerId: row.retailerId })
            .pipe(Effect.catchTag("RetailerNotFound", Effect.die))

          yield* requireHostMatch(input.command.url, retailer.domain)
        }

        yield* repo
          .update(input.pageId, input.command)
          .pipe(
            Effect.catchTag("MissingPage", (error) =>
              Effect.fail(new PagesErrors.NotFound({ pageId: error.pageId })),
            ),
          )

        return yield* get({ pageId: input.pageId })
      }),
    )
  })

  const list = Effect.fn("Pages.list")(function* (filter: Filter = {}) {
    return yield* repo.listWithStatus(filter)
  })

  const impact = Effect.fn("Pages.impact")(function* (input: Page.ImpactInput) {
    yield* repo
      .get(input.pageId)
      .pipe(
        Effect.catchTag("MissingPage", (error) =>
          Effect.fail(new PagesErrors.NotFound({ pageId: error.pageId })),
        ),
      )

    return yield* cascade.impact(CascadeRoot.Page({ id: input.pageId }))
  })

  const remove = Effect.fn("Pages.remove")(function* (input: Page.RemoveInput) {
    return (yield* cascade.remove(
      CascadeRoot.Page({ id: input.pageId }),
      repo
        .remove(input.pageId)
        .pipe(
          Effect.catchTag("MissingPage", (error) =>
            Effect.fail(new PagesErrors.NotFound({ pageId: error.pageId })),
          ),
        ),
    )).impact
  })

  const markScraped = (input: Page.MarkScrapedInput) =>
    repo.markScraped(input.pageId, input.at)

  return { create, update, get, list, impact, remove, markScraped }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([
    PagesRepo.layer,
    Brands.layer,
    Retailers.layer,
    Cascade.layer,
  ]),
)
