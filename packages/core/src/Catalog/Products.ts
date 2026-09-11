import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import type {
  CreateProduct,
  UpdateProduct,
} from "@digital-shelf/domain/Catalog/ProductManagement"
import type { ProductId } from "@digital-shelf/domain/Shared/Ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import * as Repo from "./repositories/ProductsRepo.ts"
import * as ParentRepo from "./repositories/BrandsRepo.ts"

const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const cascade = yield* Cascade

  const create = Effect.fn("Products.create")(function* (
    command: CreateProduct,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* ParentRepo.get(command.brandId)

        return yield* Repo.insert({
          ...command,
          paused: command.paused ?? false,
        })
      }),
    )
  }, withDb)

  const update = Effect.fn("Products.update")(function* (
    id: ProductId,
    command: UpdateProduct,
  ) {
    return yield* Repo.update(id, command)
  }, withDb)

  const get = Effect.fn("Products.get")(function* (id: ProductId) {
    return yield* Repo.get(id)
  }, withDb)

  const list = Effect.fn("Products.list")(function* (filter: Repo.Filter = {}) {
    return yield* Repo.list(filter).pipe(withDb)
  })

  const remove = Effect.fn("Products.remove")(function* (id: ProductId) {
    return (yield* cascade.remove(CascadeRoot.Product({ id }), Repo.remove(id)))
      .impact
  }, withDb)

  const impact = Effect.fn("Products.impact")(function* (id: ProductId) {
    yield* Repo.get(id)

    return yield* cascade.impact(CascadeRoot.Product({ id }))
  }, withDb)

  return { create, update, get, list, remove, impact }
})

export class Products extends Context.Service<
  Products,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Catalog/Products", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
