import type { Brand } from "@digital-shelf/domain/Catalog/Brand"
import type {
  CreateBrand,
  UpdateBrand,
} from "@digital-shelf/domain/Catalog/BrandManagement"
import type { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import type { BrandNotFound } from "@digital-shelf/domain/Catalog/Errors"
import type { BrandId } from "@digital-shelf/domain/Shared/Ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import * as BrandsRepo from "./repositories/BrandsRepo.ts"

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
      id: BrandId,
      command: UpdateBrand,
    ) => Effect.Effect<Brand, BrandNotFound | SqlError>
    readonly remove: (
      id: BrandId,
    ) => Effect.Effect<CascadeImpact, BrandNotFound | SqlError>
    readonly impact: (
      id: BrandId,
    ) => Effect.Effect<CascadeImpact, BrandNotFound | SqlError>
    readonly get: (
      id: BrandId,
    ) => Effect.Effect<Brand, BrandNotFound | SqlError>
    readonly list: Effect.Effect<ReadonlyArray<Brand>, SqlError>
  }
>()("@digital-shelf/core/Catalog/Brands", {
  make: Effect.gen(function* () {
    const cascade = yield* Cascade
    const db = yield* Db
    const withDb = Effect.provideService(Db, db)

    const create = Effect.fn("Brands.create")(function* (command: CreateBrand) {
      return yield* BrandsRepo.insert({
        name: command.name,
        paused: command.paused ?? false,
      })
    }, withDb)

    const update = Effect.fn("Brands.update")(function* (
      id: BrandId,
      command: UpdateBrand,
    ) {
      return yield* BrandsRepo.update(id, command)
    }, withDb)

    const remove = Effect.fn("Brands.remove")(function* (id: BrandId) {
      return (yield* cascade.remove(
        { _tag: "Brand", id },
        BrandsRepo.remove(id),
      )).impact
    }, withDb)

    const impact = Effect.fn("Brands.impact")(function* (id: BrandId) {
      yield* BrandsRepo.get(id)

      return yield* cascade.impact({ _tag: "Brand", id })
    }, withDb)

    const get = Effect.fn("Brands.get")(function* (id: BrandId) {
      return yield* BrandsRepo.get(id)
    }, withDb)

    const list = BrandsRepo.list().pipe(withDb, Effect.withSpan("Brands.list"))

    return { create, update, remove, impact, get, list }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
