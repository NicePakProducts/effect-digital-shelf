import type {
  DuplicateVariantName,
  ProductNotFound,
  VariantNotFound,
} from "@digital-shelf/domain/Catalog/Errors"
import type { Variant } from "@digital-shelf/domain/Catalog/Variant"
import type { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import type {
  CreateVariant,
  GetVariantInput,
  RemoveVariantInput,
  UpdateVariantInput,
} from "@digital-shelf/domain/Catalog/VariantManagement"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import { VariantsRepo, type Filter } from "./repositories/VariantsRepo.ts"
import { ProductsRepo } from "./repositories/ProductsRepo.ts"

export class Variants extends Context.Service<
  Variants,
  {
    readonly create: (
      command: CreateVariant,
    ) => Effect.Effect<
      Variant,
      ProductNotFound | DuplicateVariantName | SqlError
    >
    readonly update: (
      input: UpdateVariantInput,
    ) => Effect.Effect<
      Variant,
      VariantNotFound | DuplicateVariantName | SqlError
    >
    readonly get: (
      input: GetVariantInput,
    ) => Effect.Effect<Variant, VariantNotFound | SqlError>
    readonly list: (
      filter?: Filter,
    ) => Effect.Effect<ReadonlyArray<Variant>, SqlError>
    readonly remove: (
      input: RemoveVariantInput,
    ) => Effect.Effect<CascadeImpact, VariantNotFound | SqlError>
  }
>()("@digital-shelf/core/Catalog/Variants", {
  make: Effect.gen(function* () {
    const db = yield* Db
    const cascade = yield* Cascade
    const repo = yield* VariantsRepo
    const productsRepo = yield* ProductsRepo

    const create = Effect.fn("Variants.create")(function* (
      command: CreateVariant,
    ) {
      return yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* productsRepo.get(command.productId)

          return yield* repo.insert({ ...command, name: command.name.trim() })
        }),
      )
    })

    const update = Effect.fn("Variants.update")(function* (
      input: UpdateVariantInput,
    ) {
      return yield* repo.update(input.variantId, {
        name: input.command.name.trim(),
      })
    })

    const get = Effect.fn("Variants.get")(function* (input: GetVariantInput) {
      return yield* repo.get(input.variantId)
    })

    const list = Effect.fn("Variants.list")(function* (filter: Filter = {}) {
      return yield* repo.list(filter)
    })

    const remove = Effect.fn("Variants.remove")(function* (
      input: RemoveVariantInput,
    ) {
      return (yield* cascade.remove(
        CascadeRoot.Variant({ id: input.variantId }),
        repo.remove(input.variantId),
      )).impact
    })

    return { create, update, get, list, remove }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([VariantsRepo.layer, ProductsRepo.layer]),
  )
}
