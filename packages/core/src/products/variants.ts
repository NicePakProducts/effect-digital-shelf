import { ProductVariantsErrors } from "./variants/errors"
import { ProductsErrors } from "./errors"
import { ProductVariant } from "@app/schema/product-variant"
import type { VariantId } from "@app/schema/ids"
import { type CascadeImpact, CascadeRoot } from "@app/schema/cascade"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Db } from "@app/db"
import { Cascade } from "../cascade"
import { VariantsRepo, type Filter } from "./variants/repository"
import { ProductsRepo } from "./repository"

export * as ProductVariants from "./variants"

export { ProductVariantsErrors } from "./variants/errors"

export interface Interface {
  readonly notInProduct: (
    input: ProductVariant.NotInProductInput,
  ) => Effect.Effect<ReadonlyArray<VariantId>, SqlError>
  readonly create: (
    command: ProductVariant.Create,
  ) => Effect.Effect<
    ProductVariant.Info,
    ProductsErrors.NotFound | ProductVariantsErrors.DuplicateName | SqlError
  >
  readonly update: (
    input: ProductVariant.UpdateInput,
  ) => Effect.Effect<
    ProductVariant.Info,
    | ProductVariantsErrors.NotFound
    | ProductVariantsErrors.DuplicateName
    | SqlError
  >
  readonly get: (
    input: ProductVariant.GetInput,
  ) => Effect.Effect<
    ProductVariant.Info,
    ProductVariantsErrors.NotFound | SqlError
  >
  readonly list: (
    filter?: Filter,
  ) => Effect.Effect<ReadonlyArray<ProductVariant.Info>, SqlError>
  readonly remove: (
    input: ProductVariant.RemoveInput,
  ) => Effect.Effect<CascadeImpact, ProductVariantsErrors.NotFound | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/products/variants",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db
  const cascade = yield* Cascade.Service
  const repo = yield* VariantsRepo.Service
  const productsRepo = yield* ProductsRepo.Service

  const create = Effect.fn("Variants.create")(function* (
    command: ProductVariant.Create,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* productsRepo
          .get(command.productId)
          .pipe(
            Effect.catchTag("MissingProduct", (error) =>
              Effect.fail(
                new ProductsErrors.NotFound({ productId: error.productId }),
              ),
            ),
          )

        return yield* repo
          .insert({ ...command, name: command.name.trim() })
          .pipe(
            Effect.catchTag("ParentMissing", (error) =>
              Effect.fail(
                new ProductsErrors.NotFound({ productId: error.productId }),
              ),
            ),
            Effect.catchTag("NameTaken", (error) =>
              Effect.fail(
                new ProductVariantsErrors.DuplicateName({
                  productId: error.productId,
                  name: error.name,
                }),
              ),
            ),
          )
      }),
    )
  })

  const update = Effect.fn("Variants.update")(function* (
    input: ProductVariant.UpdateInput,
  ) {
    return yield* repo
      .update(input.variantId, {
        name: input.command.name.trim(),
      })
      .pipe(
        Effect.catchTag("NameTaken", (error) =>
          Effect.fail(
            new ProductVariantsErrors.DuplicateName({
              productId: error.productId,
              name: error.name,
            }),
          ),
        ),
        Effect.catchTag("MissingVariant", (error) =>
          Effect.fail(
            new ProductVariantsErrors.NotFound({ variantId: error.variantId }),
          ),
        ),
      )
  })

  const get = Effect.fn("Variants.get")(function* (
    input: ProductVariant.GetInput,
  ) {
    return yield* repo
      .get(input.variantId)
      .pipe(
        Effect.catchTag("MissingVariant", (error) =>
          Effect.fail(
            new ProductVariantsErrors.NotFound({ variantId: error.variantId }),
          ),
        ),
      )
  })

  const list = Effect.fn("Variants.list")(function* (filter: Filter = {}) {
    return yield* repo.list(filter)
  })

  const remove = Effect.fn("Variants.remove")(function* (
    input: ProductVariant.RemoveInput,
  ) {
    return (yield* cascade.remove(
      CascadeRoot.Variant({ id: input.variantId }),
      repo.remove(input.variantId).pipe(
        Effect.catchTag("MissingVariant", (error) =>
          Effect.fail(
            new ProductVariantsErrors.NotFound({
              variantId: error.variantId,
            }),
          ),
        ),
      ),
    )).impact
  })

  const notInProduct = (input: ProductVariant.NotInProductInput) =>
    repo.notInProduct(input.productId, input.variantIds)

  return { create, update, get, list, remove, notInProduct }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([VariantsRepo.layer, ProductsRepo.layer, Cascade.layer]),
)
