import { R2Bucket, StorageError } from "@digital-shelf/core/Storage/R2Bucket"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"

const make = Effect.gen(function* () {
  const objects = yield* Ref.make(
    new Map<string, { readonly body: string; readonly contentType: string }>(),
  )
  const failDelete = yield* Ref.make(false)
  const service: R2Bucket["Service"] = {
    put: (key, body, contentType) =>
      Ref.update(objects, (map) =>
        new Map(map).set(key, { body, contentType }),
      ),
    get: (key) =>
      Effect.map(Ref.get(objects), (map) =>
        Option.fromUndefinedOr(map.get(key)?.body),
      ),
    delete: (keys) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(failDelete, false))
          return yield* Effect.fail(
            new StorageError({
              operation: "delete",
              key: keys.join(","),
              cause: "scripted failure",
            }),
          )
        yield* Ref.update(objects, (map) => {
          const next = new Map(map)
          for (const key of keys) next.delete(key)
          return next
        })
      }),
  }
  return {
    service,
    inspect: Ref.get(objects),
    failNextDelete: Ref.set(failDelete, true),
    reset: Effect.gen(function* () {
      yield* Ref.set(objects, new Map())
      yield* Ref.set(failDelete, false)
    }),
  }
})
export class R2BucketTest extends Context.Service<
  R2BucketTest,
  Effect.Success<typeof make>
>()("test/R2Bucket", { make }) {}
export const layerTest = Layer.effect(
  R2Bucket,
  Effect.map(R2BucketTest, (test) => test.service),
).pipe(Layer.provideMerge(Layer.effect(R2BucketTest, R2BucketTest.make)))
