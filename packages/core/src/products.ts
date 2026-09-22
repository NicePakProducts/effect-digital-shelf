import { BrandsErrors, Brands } from "./brands"
import { ProductsErrors } from "./products/errors"
import { Product } from "@app/schema/product"
import * as Predicate from "effect/Predicate"
import { type CascadeImpact, CascadeRoot } from "@app/schema/cascade"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Db } from "@app/db"
import { Cascade } from "./cascade"
import { ProductsRepo, type Filter } from "./products/repository"

export * as Products from "./products"

export { ProductsErrors } from "./products/errors"

export interface Interface {
  readonly create: (
    command: Product.Create,
  ) => Effect.Effect<Product.Info, BrandsErrors.NotFound | SqlError>
  readonly update: (
    input: Product.UpdateInput,
  ) => Effect.Effect<Product.Info, ProductsErrors.NotFound | SqlError>
  readonly get: (
    input: Product.GetInput,
  ) => Effect.Effect<Product.Info, ProductsErrors.NotFound | SqlError>
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<Product.Info>, SqlError>
  readonly remove: (
    input: Product.RemoveInput,
  ) => Effect.Effect<CascadeImpact, ProductsErrors.NotFound | SqlError>
  readonly impact: (
    input: Product.ImpactInput,
  ) => Effect.Effect<CascadeImpact, ProductsErrors.NotFound | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/products",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db
  const cascade = yield* Cascade.Service
  const repo = yield* ProductsRepo.Service
  const brands = yield* Brands.Service

  const create = Effect.fn("Products.create")(function* (
    command: Product.Create,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* brands.get({ brandId: command.brandId })

        return yield* repo.insert({
          ...command,
          paused: command.paused ?? false,
        })
      }),
    )
  })

  const update = Effect.fn("Products.update")(function* (
    input: Product.UpdateInput,
  ) {
    return yield* repo
      .update(input.productId, input.command)
      .pipe(Effect.mapError(mapFailure))
  })

  const get = Effect.fn("Products.get")(function* (input: Product.GetInput) {
    return yield* repo.get(input.productId).pipe(Effect.mapError(mapFailure))
  })

  const list = Effect.fn("Products.list")(function* (filter: Filter = {}) {
    return yield* repo.list(filter)
  })

  const remove = Effect.fn("Products.remove")(function* (
    input: Product.RemoveInput,
  ) {
    return (yield* cascade.remove(
      CascadeRoot.Product({ id: input.productId }),
      repo.remove(input.productId).pipe(Effect.mapError(mapFailure)),
    )).impact
  })

  const impact = Effect.fn("Products.impact")(function* (
    input: Product.ImpactInput,
  ) {
    yield* repo.get(input.productId).pipe(Effect.mapError(mapFailure))

    return yield* cascade.impact(CascadeRoot.Product({ id: input.productId }))
  })

  return { create, update, get, list, remove, impact }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([ProductsRepo.layer, Brands.layer, Cascade.layer]),
)

const mapFailure = (error: ProductsRepo.MissingProduct | SqlError) =>
  Predicate.isTagged(error, "MissingProduct")
    ? new ProductsErrors.NotFound({ productId: error.productId })
    : error
