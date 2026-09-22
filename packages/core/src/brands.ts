import { CascadeRoot, type CascadeImpact } from "@app/schema/cascade"
import type { Brand } from "@app/schema/brand"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Cascade } from "./cascade"
import { BrandsRepo } from "./brands/repository"
import { BrandsErrors } from "./brands/errors"

/**
 * Brand commands and reads as the api calls them. Commands take the domain's
 * command structs and return the entity; the wire shape is the api's
 * projection. `remove` delegates to Catalog/Cascade, so the
 * Scrape ids the database cascade drops are collected before the delete.
 */
export * as Brands from "./brands"

export { BrandsErrors } from "./brands/errors"

export interface Interface {
  readonly create: (
    command: Brand.Create,
  ) => Effect.Effect<Brand.Info, SqlError>
  readonly update: (
    input: Brand.UpdateInput,
  ) => Effect.Effect<Brand.Info, BrandsErrors.NotFound | SqlError>
  readonly remove: (
    input: Brand.RemoveInput,
  ) => Effect.Effect<CascadeImpact, BrandsErrors.NotFound | SqlError>
  readonly impact: (
    input: Brand.ImpactInput,
  ) => Effect.Effect<CascadeImpact, BrandsErrors.NotFound | SqlError>
  readonly get: (
    input: Brand.GetInput,
  ) => Effect.Effect<Brand.Info, BrandsErrors.NotFound | SqlError>
  readonly list: Effect.Effect<ReadonlyArray<Brand.Info>, SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/brands",
) {}

const make = Effect.gen(function* () {
  const cascade = yield* Cascade.Service
  const repo = yield* BrandsRepo.Service

  const create = Effect.fn("Brands.create")(function* (command: Brand.Create) {
    return yield* repo.insert({
      name: command.name,
      paused: command.paused ?? false,
    })
  })

  const update = Effect.fn("Brands.update")(function* (
    input: Brand.UpdateInput,
  ) {
    return yield* repo
      .update(input.brandId, input.command)
      .pipe(
        Effect.catchTag("MissingBrand", (error) =>
          Effect.fail(new BrandsErrors.NotFound({ brandId: error.brandId })),
        ),
      )
  })

  const remove = Effect.fn("Brands.remove")(function* (
    input: Brand.RemoveInput,
  ) {
    const result = yield* cascade.remove(
      CascadeRoot.Brand({ id: input.brandId }),
      repo
        .remove(input.brandId)
        .pipe(
          Effect.catchTag("MissingBrand", (error) =>
            Effect.fail(new BrandsErrors.NotFound({ brandId: error.brandId })),
          ),
        ),
    )

    return result.impact
  })

  const impact = Effect.fn("Brands.impact")(function* (
    input: Brand.ImpactInput,
  ) {
    yield* repo
      .get(input.brandId)
      .pipe(
        Effect.catchTag("MissingBrand", (error) =>
          Effect.fail(new BrandsErrors.NotFound({ brandId: error.brandId })),
        ),
      )

    return yield* cascade.impact(CascadeRoot.Brand({ id: input.brandId }))
  })

  const get = Effect.fn("Brands.get")(function* (input: Brand.GetInput) {
    return yield* repo
      .get(input.brandId)
      .pipe(
        Effect.catchTag("MissingBrand", (error) =>
          Effect.fail(new BrandsErrors.NotFound({ brandId: error.brandId })),
        ),
      )
  })

  const list = repo.list.pipe(Effect.withSpan("Brands.list"))

  return { create, update, remove, impact, get, list }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([BrandsRepo.layer, Cascade.layer]),
)
