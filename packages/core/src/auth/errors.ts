export * as AuthErrors from "./errors"

import * as Data from "effect/Data"

export class SessionLookupFailed extends Data.TaggedError(
  "SessionLookupFailed",
)<{
  readonly cause: unknown
}> {}
