import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import type {
  CreateVariant,
  UpdateVariant,
} from "@digital-shelf/domain/Catalog/VariantManagement"
import type { VariantId } from "@digital-shelf/domain/Shared/Ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import * as Repo from "./repositories/VariantsRepo.ts"
import * as ParentRepo from "./repositories/ProductsRepo.ts"

const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const cascade = yield* Cascade

  const create = Effect.fn("Variants.create")(function* (
    command: CreateVariant,
  ) {
    return yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* ParentRepo.get(command.productId)

        return yield* Repo.insert({ ...command, name: command.name.trim() })
      }),
    )
  }, withDb)

  const update = Effect.fn("Variants.update")(function* (
    id: VariantId,
    command: UpdateVariant,
  ) {
    return yield* Repo.update(id, { name: command.name.trim() })
  }, withDb)

  const get = Effect.fn("Variants.get")(function* (id: VariantId) {
    return yield* Repo.get(id)
  }, withDb)

  const list = Effect.fn("Variants.list")(function* (filter: Repo.Filter = {}) {
    return yield* Repo.list(filter).pipe(withDb)
  })

  const remove = Effect.fn("Variants.remove")(function* (id: VariantId) {
    return (yield* cascade.remove(CascadeRoot.Variant({ id }), Repo.remove(id)))
      .impact
  }, withDb)

  return { create, update, get, list, remove }
})

export class Variants extends Context.Service<
  Variants,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Catalog/Variants", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
