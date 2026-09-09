import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"

/**
 * The object store holding each Scrape's captured HTML and the provider's
 * forensic response, under keys derived from the Scrape id
 * (Scraping/R2Keys.ts). Core defines the port; infra satisfies it from the
 * bucket binding. Bodies are text: HTML or JSON.
 */

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly operation: "put" | "get" | "delete"
  readonly key: string
  readonly cause: unknown
}> {}

export class R2Bucket extends Context.Service<
  R2Bucket,
  {
    readonly put: (
      key: string,
      body: string,
      contentType: string,
    ) => Effect.Effect<void, StorageError>
    readonly get: (
      key: string,
    ) => Effect.Effect<Option.Option<string>, StorageError>
    /** Missing keys are not an error. */
    readonly delete: (
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<void, StorageError>
  }
>()("@digital-shelf/core/Storage/R2Bucket") {}
