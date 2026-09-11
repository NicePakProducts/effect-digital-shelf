import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import type { Brand } from "@digital-shelf/domain/Catalog/Brand"
import type {
  CreateBrand,
  GetBrand,
  RemoveBrand,
  BrandImpact,
  UpdateBrand,
} from "@digital-shelf/domain/Catalog/BrandManagement"
import type { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import type { BrandNotFound } from "@digital-shelf/domain/Catalog/Errors"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Cascade } from "./Cascade.ts"
import { BrandsRepo } from "./repositories/BrandsRepo.ts"

/**
 * Brand commands and reads as the api calls them. Commands take the domain's
 * command structs and return the entity; the wire shape is the api's
 * projection. `remove` delegates to Catalog/Cascade, so the
 * Scrape ids the database cascade drops are collected before the delete.
 */
export class Brands extends Context.Service<
  Brands,
  {
    readonly create: (command: CreateBrand) => Effect.Effect<Brand, SqlError>
    readonly update: (
      input: UpdateBrand,
    ) => Effect.Effect<Brand, BrandNotFound | SqlError>
    readonly remove: (
      input: RemoveBrand,
    ) => Effect.Effect<CascadeImpact, BrandNotFound | SqlError>
    readonly impact: (
      input: BrandImpact,
    ) => Effect.Effect<CascadeImpact, BrandNotFound | SqlError>
    readonly get: (
      input: GetBrand,
    ) => Effect.Effect<Brand, BrandNotFound | SqlError>
    readonly list: Effect.Effect<ReadonlyArray<Brand>, SqlError>
  }
>()("@digital-shelf/core/Catalog/Brands", {
  make: Effect.gen(function* () {
    const cascade = yield* Cascade
    const repo = yield* BrandsRepo

    const create = Effect.fn("Brands.create")(function* (command: CreateBrand) {
      return yield* repo.insert({
        name: command.name,
        paused: command.paused ?? false,
      })
    })

    const update = Effect.fn("Brands.update")(function* (input: UpdateBrand) {
      return yield* repo.update(input.brandId, input.command)
    })

    const remove = Effect.fn("Brands.remove")(function* (input: RemoveBrand) {
      const result = yield* cascade.remove(
        CascadeRoot.Brand({ id: input.brandId }),
        repo.remove(input.brandId),
      )

      return result.impact
    })

    const impact = Effect.fn("Brands.impact")(function* (input: BrandImpact) {
      yield* repo.get(input.brandId)

      return yield* cascade.impact(CascadeRoot.Brand({ id: input.brandId }))
    })

    const get = Effect.fn("Brands.get")(function* (input: GetBrand) {
      return yield* repo.get(input.brandId)
    })

    const list = repo.list.pipe(Effect.withSpan("Brands.list"))

    return { create, update, remove, impact, get, list }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(BrandsRepo.layer),
  )
}
