import { R2Bucket, StorageError } from "@digital-shelf/core/Storage/R2Bucket"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"

/** The text-only subset of Alchemy's ReadWriteBucketClient, not raw R2. */
export interface BucketClient<R = never> {
  readonly put: (
    key: string,
    body: string,
    options: {
      readonly httpMetadata: { readonly contentType: string }
    },
  ) => Effect.Effect<unknown, unknown, R>
  readonly get: (key: string) => Effect.Effect<
    {
      readonly text: () => Effect.Effect<string, unknown>
    } | null,
    unknown,
    R
  >
  readonly delete: (key: string) => Effect.Effect<void, unknown, R>
}

/** Capture the client's runtime services when built inside the invocation. */
export const layer = <R>(client: BucketClient<R>) =>
  Layer.effect(
    R2Bucket,
    Effect.gen(function* () {
      // Captures the build-time context, including Scope and ParentSpan: client
      // calls use the layer's build span, not the per-call R2Bucket.* span.
      // Alchemy's client only wraps promises; revisit with #40 if spans matter.
      const services = yield* Effect.context<R>()

      const run = <A>(
        operation: StorageError["operation"],
        key: string,
        effect: () => Effect.Effect<A, unknown, R>,
      ) =>
        Effect.suspend(effect).pipe(
          Effect.provide(services),
          Effect.mapError(
            (cause) => new StorageError({ operation, key, cause }),
          ),
          Effect.catchDefect((cause) =>
            Effect.fail(new StorageError({ operation, key, cause })),
          ),
        )

      return R2Bucket.of({
        put: Effect.fn("R2Bucket.put")((key, body, contentType) =>
          run("put", key, () =>
            client.put(key, body, { httpMetadata: { contentType } }),
          ).pipe(Effect.asVoid),
        ),
        get: Effect.fn("R2Bucket.get")((key) =>
          run("get", key, () =>
            Effect.gen(function* () {
              const object = yield* client.get(key)

              return object === null
                ? Option.none()
                : Option.some(yield* object.text())
            }),
          ),
        ),
        delete: Effect.fn("R2Bucket.delete")((keys) =>
          Effect.forEach(
            keys,
            (key) => run("delete", key, () => client.delete(key)),
            { discard: true },
          ),
        ),
      })
    }),
  )
