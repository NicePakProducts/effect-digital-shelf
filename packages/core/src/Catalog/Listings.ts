import { defaultCadence } from "@digital-shelf/domain/Catalog/Cadence"
import {
  ListingNotFound,
  VariantNotInProduct,
} from "@digital-shelf/domain/Catalog/Errors"
import type {
  CreateListing,
  UpdateListing,
} from "@digital-shelf/domain/Catalog/ListingManagement"
import type {
  ListingId,
  ProductId,
  VariantId,
} from "@digital-shelf/domain/Shared/Ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import { requireHostMatch } from "./HostRule.ts"
import * as Repo from "./repositories/ListingsRepo.ts"
import * as ProductsRepo from "./repositories/ProductsRepo.ts"
import * as RetailersRepo from "./repositories/RetailersRepo.ts"

const validateCoverage = Effect.fn("Listings.validateCoverage")(function* (
  productId: ProductId,
  ids: ReadonlyArray<VariantId>,
) {
  const invalid = yield* Repo.variantsNotInProduct(productId, ids)
  const first = invalid[0]
  if (first !== undefined)
    return yield* Effect.fail(
      new VariantNotInProduct({ productId, variantId: first }),
    )
})
const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const cascade = yield* Cascade
  const get = Effect.fn("Listings.get")(function* (id: ListingId) {
    const row = yield* Repo.findWithStatus(id)
    return yield* Option.match(row, {
      onNone: () => Effect.fail(new ListingNotFound({ listingId: id })),
      onSome: Effect.succeed,
    })
  }, withDb)
  const create = Effect.fn("Listings.create")(function* (
    command: CreateListing,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* ProductsRepo.get(command.productId)
        const retailer = yield* RetailersRepo.getForShare(command.retailerId)
        yield* requireHostMatch(command.url, retailer.domain)
        yield* validateCoverage(command.productId, command.variantIds ?? [])
        const { variantIds, ...values } = command
        const row = yield* Repo.insert({
          ...values,
          cadence: command.cadence ?? defaultCadence,
        })
        if (variantIds !== undefined)
          yield* Repo.replaceCoverage(row.id, variantIds)
        return yield* Option.match(yield* Repo.findWithStatus(row.id), {
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
  }, withDb)
  const update = Effect.fn("Listings.update")(function* (
    id: ListingId,
    command: UpdateListing,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const row = yield* Repo.get(id)
        if (command.url !== undefined) {
          // The foreign key guarantees the Retailer: its absence is a defect.
          const retailer = yield* RetailersRepo.getForShare(
            row.retailerId,
          ).pipe(Effect.catchTag("RetailerNotFound", Effect.die))
          yield* requireHostMatch(command.url, retailer.domain)
        }
        const { variantIds, ...patch } = command
        if (variantIds !== undefined) {
          yield* validateCoverage(row.productId, variantIds)
          yield* Repo.replaceCoverage(id, variantIds)
        }
        yield* Repo.update(id, patch)
        return yield* get(id)
      }),
    )
  }, withDb)
  const list = Effect.fn("Listings.list")(function* (filter: Repo.Filter = {}) {
    return yield* Repo.listWithStatus(filter).pipe(withDb)
  })
  const impact = Effect.fn("Listings.impact")(function* (id: ListingId) {
    yield* Repo.get(id)
    return yield* cascade.impact({ _tag: "Listing", id })
  }, withDb)
  const remove = Effect.fn("Listings.remove")(function* (id: ListingId) {
    return (yield* cascade.remove({ _tag: "Listing", id }, Repo.remove(id)))
      .impact
  }, withDb)
  return { create, update, get, list, impact, remove }
})
export class Listings extends Context.Service<
  Listings,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Catalog/Listings", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
