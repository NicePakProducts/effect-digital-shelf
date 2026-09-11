import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { R2Bucket, StorageError } from "@digital-shelf/core/Storage/R2Bucket"
import * as Adapter from "@digital-shelf/infra/Adapters/R2Bucket"
import type { ReadWriteBucketClient } from "alchemy/Cloudflare/R2"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

const fake = () => {
  const objects = new Map<string, { body: string; contentType: string }>()

  const client: Adapter.BucketClient = {
    put: (key, body, { httpMetadata }) =>
      Effect.sync(() => {
        objects.set(key, { body, contentType: httpMetadata.contentType })
      }),
    get: (key) =>
      Effect.sync(() => {
        const object = objects.get(key)

        return object === undefined
          ? null
          : { text: () => Effect.succeed(object.body) }
      }),
    delete: (key) =>
      Effect.sync(() => {
        objects.delete(key)
      }),
  }

  return { client, objects }
}

describe("R2 adapter", () => {
  it("accepts the Alchemy client without a cast", () => {
    expectTypeOf<ReadWriteBucketClient>().toExtend<
      Adapter.BucketClient<RuntimeContext>
    >()
  })

  it.effect(
    "round-trips text and content type, with absence and idempotent deletes",
    () => {
      const { client, objects } = fake()

      return Effect.gen(function* () {
        const bucket = yield* R2Bucket
        expect(yield* bucket.get("missing")).toEqual(Option.none())
        yield* bucket.put("html/one", "<p>héllo</p>", "text/html")
        yield* bucket.put("raw/two", '{"ok":true}', "application/json")
        expect(objects.get("html/one")).toEqual({
          body: "<p>héllo</p>",
          contentType: "text/html",
        })
        expect(objects.get("raw/two")?.contentType).toBe("application/json")
        expect(yield* bucket.get("html/one")).toEqual(
          Option.some("<p>héllo</p>"),
        )
        yield* bucket.delete(["html/one", "raw/two", "missing"])
        yield* bucket.delete(["html/one"])
        yield* bucket.delete([])
        expect(objects.size).toBe(0)
      }).pipe(Effect.provide(Adapter.layer(client)))
    },
  )

  for (const operation of ["put", "get", "delete"] as const) {
    for (const mode of ["failure", "defect", "throw"] as const) {
      it.effect(
        `wraps ${operation} ${mode} with the operation and actual key`,
        () => {
          const { client } = fake()
          const cause = new Error("storage offline")

          const fail = () => {
            if (mode === "throw") throw cause

            return mode === "failure" ? Effect.fail(cause) : Effect.die(cause)
          }

          return Effect.gen(function* () {
            const bucket = yield* R2Bucket

            const call =
              operation === "put"
                ? bucket.put("key", "body", "text/plain")
                : operation === "get"
                  ? bucket.get("key")
                  : bucket.delete(["key"])

            expect(yield* Effect.flip(call)).toEqual(
              new StorageError({ operation, key: "key", cause }),
            )
          }).pipe(
            Effect.provide(Adapter.layer({ ...client, [operation]: fail })),
          )
        },
      )
    }
  }

  it.effect("attributes a text-body failure to get", () => {
    const { client } = fake()
    const cause = new Error("body read failed")

    return Effect.gen(function* () {
      const bucket = yield* R2Bucket
      expect(yield* Effect.flip(bucket.get("html/one"))).toEqual(
        new StorageError({ operation: "get", key: "html/one", cause }),
      )
    }).pipe(
      Effect.provide(
        Adapter.layer({
          ...client,
          get: () => Effect.succeed({ text: () => Effect.die(cause) }),
        }),
      ),
    )
  })

  it.effect("captures runtime services at layer construction", () => {
    class Binding extends Context.Service<Binding, string>()(
      "test/R2Binding",
    ) {}

    const { client } = fake()

    const needsBinding: Adapter.BucketClient<Binding> = {
      ...client,
      get: () =>
        Effect.map(Binding, (body) => ({ text: () => Effect.succeed(body) })),
    }

    return Effect.gen(function* () {
      const bucket = yield* R2Bucket
      expect(yield* bucket.get("key")).toEqual(Option.some("from binding"))
    }).pipe(
      Effect.provide(
        Adapter.layer(needsBinding).pipe(
          Layer.provide(Layer.succeed(Binding, "from binding")),
        ),
      ),
    )
  })
})
