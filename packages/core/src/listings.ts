import { ListingsErrors } from "./listings/errors"
import { RetailersErrors, Retailers, requireHostMatch } from "./retailers"
import { ProductsErrors, Products } from "./products"
import type { VariantId, ProductId } from "@app/schema/ids"
import type { Listing } from "@app/schema/listing"
import { ProductVariants } from "./products/variants"
import { type CascadeImpact, CascadeRoot } from "@app/schema/cascade"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { defaultCadence } from "@app/schema/cadence"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { Db } from "@app/db"
import { Cascade } from "./cascade"
import { ListingsRepo, type Filter } from "./listings/repository"

export * as Listings from "./listings"

export { ListingsErrors } from "./listings/errors"

export interface Interface {
  readonly markScraped: (
    input: Listing.MarkScrapedInput,
  ) => Effect.Effect<void, SqlError>
  readonly create: (
    command: Listing.Create,
  ) => Effect.Effect<
    Listing.WithStatus,
    | ProductsErrors.NotFound
    | RetailersErrors.NotFound
    | RetailersErrors.UrlHostMismatch
    | ListingsErrors.VariantNotInProduct
    | SqlError
  >
  readonly update: (
    input: Listing.UpdateInput,
  ) => Effect.Effect<
    Listing.WithStatus,
    | ListingsErrors.NotFound
    | RetailersErrors.UrlHostMismatch
    | ListingsErrors.VariantNotInProduct
    | SqlError
  >
  readonly get: (
    input: Listing.GetInput,
  ) => Effect.Effect<Listing.WithStatus, ListingsErrors.NotFound | SqlError>
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Listing.WithStatus>, SqlError>
  readonly remove: (
    input: Listing.RemoveInput,
  ) => Effect.Effect<CascadeImpact, ListingsErrors.NotFound | SqlError>
  readonly impact: (
    input: Listing.ImpactInput,
  ) => Effect.Effect<CascadeImpact, ListingsErrors.NotFound | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/listings",
) {}

const make = Effect.gen(function* () {
  const variants = yield* ProductVariants.Service
  const db = yield* Db
  const cascade = yield* Cascade.Service
  const repo = yield* ListingsRepo.Service
  const products = yield* Products.Service
  const retailersRepo = yield* Retailers.Service

  const validateCoverage = Effect.fn("Listings.validateCoverage")(function* (
    productId: ProductId,
    ids: ReadonlyArray<VariantId>,
  ) {
    const invalid = yield* variants.notInProduct({ productId, variantIds: ids })
    const first = invalid[0]

    if (first !== undefined)
      return yield* Effect.fail(
        new ListingsErrors.VariantNotInProduct({ productId, variantId: first }),
      )
  })

  const get = Effect.fn("Listings.get")(function* (input: Listing.GetInput) {
    const row = yield* repo.findWithStatus(input.listingId)

    return yield* Option.match(row, {
      onNone: () =>
        Effect.fail(
          new ListingsErrors.NotFound({ listingId: input.listingId }),
        ),
      onSome: Effect.succeed,
    })
  })

  const create = Effect.fn("Listings.create")(function* (
    command: Listing.Create,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* products.get({ productId: command.productId })

        const retailer = yield* retailersRepo.getForShare({
          retailerId: command.retailerId,
        })

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
    input: Listing.UpdateInput,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const row = yield* repo
          .get(input.listingId)
          .pipe(
            Effect.catchTag("MissingListing", (error) =>
              Effect.fail(
                new ListingsErrors.NotFound({ listingId: error.listingId }),
              ),
            ),
          )

        if (input.command.url !== undefined) {
          // The foreign key guarantees the Retailer: its absence is a defect.
          const retailer = yield* retailersRepo
            .getForShare({ retailerId: row.retailerId })
            .pipe(Effect.catchTag("RetailerNotFound", Effect.die))

          yield* requireHostMatch(input.command.url, retailer.domain)
        }

        const { variantIds, ...patch } = input.command

        if (variantIds !== undefined) {
          yield* validateCoverage(row.productId, variantIds)
          yield* repo.replaceCoverage(input.listingId, variantIds)
        }

        yield* repo
          .update(input.listingId, patch)
          .pipe(
            Effect.catchTag("MissingListing", (error) =>
              Effect.fail(
                new ListingsErrors.NotFound({ listingId: error.listingId }),
              ),
            ),
          )

        return yield* get({ listingId: input.listingId })
      }),
    )
  })

  const list = Effect.fn("Listings.list")(function* (filter: Filter = {}) {
    return yield* repo.listWithStatus(filter)
  })

  const impact = Effect.fn("Listings.impact")(function* (
    input: Listing.ImpactInput,
  ) {
    yield* repo
      .get(input.listingId)
      .pipe(
        Effect.catchTag("MissingListing", (error) =>
          Effect.fail(
            new ListingsErrors.NotFound({ listingId: error.listingId }),
          ),
        ),
      )

    return yield* cascade.impact(CascadeRoot.Listing({ id: input.listingId }))
  })

  const remove = Effect.fn("Listings.remove")(function* (
    input: Listing.RemoveInput,
  ) {
    return (yield* cascade.remove(
      CascadeRoot.Listing({ id: input.listingId }),
      repo
        .remove(input.listingId)
        .pipe(
          Effect.catchTag("MissingListing", (error) =>
            Effect.fail(
              new ListingsErrors.NotFound({ listingId: error.listingId }),
            ),
          ),
        ),
    )).impact
  })

  const markScraped = (input: Listing.MarkScrapedInput) =>
    repo.markScraped(input.listingId, input.at)

  return { create, update, get, list, impact, remove, markScraped }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([
    ListingsRepo.layer,
    Products.layer,
    ProductVariants.layer,
    Retailers.layer,
    Cascade.layer,
  ]),
)
