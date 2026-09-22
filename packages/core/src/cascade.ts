import type { CascadeImpact, CascadeRoot } from "@app/schema/cascade"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Db } from "@app/db"
import { R2Bucket } from "./storage/r2-bucket"
import { keysOf } from "./scrapes/r2-keys"
import { CascadeRepo } from "./cascade/repository"

// R2 accepts at most 1000 object keys in one delete call.
const R2_DELETE_KEY_LIMIT = 1000

const make = Effect.gen(function* () {
  const db = yield* Db
  const bucket = yield* R2Bucket.Service
  const repo = yield* CascadeRepo.Service

  const impact = Effect.fn("Cascade.impact")(function* (root: CascadeRoot) {
    return yield* repo.impact(root)
  })

  /** Collect descendants and remove the row in one transaction, then clean R2 after commit. */
  const remove = Effect.fn("Cascade.remove")(function* <A, E>(
    root: CascadeRoot,
    remove: Effect.Effect<A, E>,
  ) {
    const result = yield* db.transaction(() =>
      Effect.gen(function* () {
        const impact = yield* repo.impact(root)
        // A concurrent descendant dispatch can miss this collection; ADR 0001
        // requires the bucket lifecycle rule to backstop orphaned objects.
        const ids = yield* repo.scrapeIds(root)
        const removed = yield* remove

        return { impact, ids, removed }
      }),
    )

    yield* Effect.annotateCurrentSpan(
      "shelf.cascade.scrapes",
      result.ids.length,
    )
    const keys = result.ids.flatMap(keysOf)

    for (const batch of Array.chunksOf(keys, R2_DELETE_KEY_LIMIT)) {
      yield* bucket
        .delete(batch)
        .pipe(
          Effect.catchTag("StorageError", (error) =>
            Effect.logWarning("Cascade object deletion failed", error),
          ),
        )
    }

    return { removed: result.removed, impact: result.impact }
  })

  return { impact, remove }
})

export * as Cascade from "./cascade"

export interface Interface {
  readonly impact: (root: CascadeRoot) => Effect.Effect<CascadeImpact, SqlError>
  readonly remove: <A, E>(
    root: CascadeRoot,
    remove: Effect.Effect<A, E>,
  ) => Effect.Effect<
    { readonly removed: A; readonly impact: CascadeImpact },
    E | SqlError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/cascade",
) {}

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(Layer.provide(CascadeRepo.layer))
