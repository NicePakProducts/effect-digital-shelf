import type {
  BrandNotFound,
  ProductNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import type { Product } from "@digital-shelf/domain/Catalog/Product"
import type { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import type {
  CreateProduct,
  GetProductInput,
  RemoveProductInput,
  UpdateProductInput,
  ProductImpactInput,
} from "@digital-shelf/domain/Catalog/ProductManagement"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import { ProductsRepo, type Filter } from "./repositories/ProductsRepo.ts"
import { BrandsRepo } from "./repositories/BrandsRepo.ts"

export class Products extends Context.Service<
  Products,
  {
    readonly create: (
      command: CreateProduct,
    ) => Effect.Effect<Product, BrandNotFound | SqlError>
    readonly update: (
      input: UpdateProductInput,
    ) => Effect.Effect<Product, ProductNotFound | SqlError>
    readonly get: (
      input: GetProductInput,
    ) => Effect.Effect<Product, ProductNotFound | SqlError>
    readonly list: (
      filter?: Filter,
    ) => Effect.Effect<ReadonlyArray<Product>, SqlError>
    readonly remove: (
      input: RemoveProductInput,
    ) => Effect.Effect<CascadeImpact, ProductNotFound | SqlError>
    readonly impact: (
      input: ProductImpactInput,
    ) => Effect.Effect<CascadeImpact, ProductNotFound | SqlError>
  }
>()("@digital-shelf/core/Catalog/Products", {
  make: Effect.gen(function* () {
    const db = yield* Db
    const cascade = yield* Cascade
    const repo = yield* ProductsRepo
    const brandsRepo = yield* BrandsRepo

    const create = Effect.fn("Products.create")(function* (
      command: CreateProduct,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* brandsRepo.get(command.brandId)

          return yield* repo.insert({
            ...command,
            paused: command.paused ?? false,
          })
        }),
      )
    })

    const update = Effect.fn("Products.update")(function* (
      input: UpdateProductInput,
    ) {
      return yield* repo.update(input.productId, input.command)
    })

    const get = Effect.fn("Products.get")(function* (input: GetProductInput) {
      return yield* repo.get(input.productId)
    })

    const list = Effect.fn("Products.list")(function* (filter: Filter = {}) {
      return yield* repo.list(filter)
    })

    const remove = Effect.fn("Products.remove")(function* (
      input: RemoveProductInput,
    ) {
      return (yield* cascade.remove(
        CascadeRoot.Product({ id: input.productId }),
        repo.remove(input.productId),
      )).impact
    })

    const impact = Effect.fn("Products.impact")(function* (
      input: ProductImpactInput,
    ) {
      yield* repo.get(input.productId)

      return yield* cascade.impact(CascadeRoot.Product({ id: input.productId }))
    })

    return { create, update, get, list, remove, impact }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([ProductsRepo.layer, BrandsRepo.layer]),
  )
}
