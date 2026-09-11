import {
  type RetailerNotFound,
  type ProductNotFound,
  type UrlHostMismatch,
  ListingNotFound,
  VariantNotInProduct,
} from "@digital-shelf/domain/Catalog/Errors"
import type { ListingWithStatus } from "@digital-shelf/domain/Catalog/Listing"
import type { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import { defaultCadence } from "@digital-shelf/domain/Catalog/Cadence"
import type {
  CreateListing,
  GetListingInput,
  RemoveListingInput,
  UpdateListingInput,
  ListingImpactInput,
} from "@digital-shelf/domain/Catalog/ListingManagement"
import type { ProductId, VariantId } from "@digital-shelf/domain/Shared/Ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import { requireHostMatch } from "./HostRule.ts"
import { ListingsRepo, type Filter } from "./repositories/ListingsRepo.ts"
import { ProductsRepo } from "./repositories/ProductsRepo.ts"
import { RetailersRepo } from "./repositories/RetailersRepo.ts"

export class Listings extends Context.Service<
  Listings,
  {
    readonly create: (
      command: CreateListing,
    ) => Effect.Effect<
      ListingWithStatus,
      | ProductNotFound
      | RetailerNotFound
      | UrlHostMismatch
      | VariantNotInProduct
      | SqlError
    >
    readonly update: (
      input: UpdateListingInput,
    ) => Effect.Effect<
      ListingWithStatus,
      ListingNotFound | UrlHostMismatch | VariantNotInProduct | SqlError
    >
    readonly get: (
      input: GetListingInput,
    ) => Effect.Effect<ListingWithStatus, ListingNotFound | SqlError>
    readonly list: (
      filter?: Filter,
    ) => Effect.Effect<ReadonlyArray<ListingWithStatus>, SqlError>
    readonly remove: (
      input: RemoveListingInput,
    ) => Effect.Effect<CascadeImpact, ListingNotFound | SqlError>
    readonly impact: (
      input: ListingImpactInput,
    ) => Effect.Effect<CascadeImpact, ListingNotFound | SqlError>
  }
>()("@digital-shelf/core/Catalog/Listings", {
  make: Effect.gen(function* () {
    const db = yield* Db
    const cascade = yield* Cascade
    const repo = yield* ListingsRepo
    const productsRepo = yield* ProductsRepo
    const retailersRepo = yield* RetailersRepo

    const validateCoverage = Effect.fn("Listings.validateCoverage")(function* (
      productId: ProductId,
      ids: ReadonlyArray<VariantId>,
    ) {
      const invalid = yield* repo.variantsNotInProduct(productId, ids)
      const first = invalid[0]

      if (first !== undefined)
        return yield* Effect.fail(
          new VariantNotInProduct({ productId, variantId: first }),
        )
    })

    const get = Effect.fn("Listings.get")(function* (input: GetListingInput) {
      const row = yield* repo.findWithStatus(input.listingId)

      return yield* Option.match(row, {
        onNone: () =>
          Effect.fail(new ListingNotFound({ listingId: input.listingId })),
        onSome: Effect.succeed,
      })
    })

    const create = Effect.fn("Listings.create")(function* (
      command: CreateListing,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* productsRepo.get(command.productId)
          const retailer = yield* retailersRepo.getForShare(command.retailerId)
          yield* requireHostMatch(command.url, retailer.domain)
          yield* validateCoverage(command.productId, command.variantIds ?? [])
          const { variantIds, ...values } = command

          const row = yield* repo.insert({
            ...values,
            cadence: command.cadence ?? defaultCadence,
          })

          if (variantIds !== undefined)
            yield* repo.replaceCoverage(row.id, variantIds)

          return yield* Option.match(yield* repo.findWithStatus(row.id), {
            onNone: () =>
              Effect.die(
                new Error(
                  "Inserted Listing disappeared before its status could be read",
                ),
              ),
            onSome: Effect.succeed,
          })
        }),
      )
    })

    const update = Effect.fn("Listings.update")(function* (
      input: UpdateListingInput,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          const row = yield* repo.get(input.listingId)

          if (input.command.url !== undefined) {
            // The foreign key guarantees the Retailer: its absence is a defect.
            const retailer = yield* retailersRepo
              .getForShare(row.retailerId)
              .pipe(Effect.catchTag("RetailerNotFound", Effect.die))

            yield* requireHostMatch(input.command.url, retailer.domain)
          }

          const { variantIds, ...patch } = input.command

          if (variantIds !== undefined) {
            yield* validateCoverage(row.productId, variantIds)
            yield* repo.replaceCoverage(input.listingId, variantIds)
          }

          yield* repo.update(input.listingId, patch)

          return yield* get({ listingId: input.listingId })
        }),
      )
    })

    const list = Effect.fn("Listings.list")(function* (filter: Filter = {}) {
      return yield* repo.listWithStatus(filter)
    })

    const impact = Effect.fn("Listings.impact")(function* (
      input: ListingImpactInput,
    ) {
      yield* repo.get(input.listingId)

      return yield* cascade.impact(CascadeRoot.Listing({ id: input.listingId }))
    })

    const remove = Effect.fn("Listings.remove")(function* (
      input: RemoveListingInput,
    ) {
      return (yield* cascade.remove(
        CascadeRoot.Listing({ id: input.listingId }),
        repo.remove(input.listingId),
      )).impact
    })

    return { create, update, get, list, impact, remove }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      ListingsRepo.layer,
      ProductsRepo.layer,
      RetailersRepo.layer,
    ]),
  )
}
