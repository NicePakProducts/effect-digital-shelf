import * as Predicate from "effect/Predicate"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import {
  SqlError,
  UnknownError,
  isSqlError,
} from "effect/unstable/sql/SqlError"

/**
 * Drizzle fails a query with `EffectDrizzleQueryError`, whose `cause` is the
 * `Cause` that carried the driver's `SqlError`. Repositories unwrap it here so
 * every query fails with the one `SqlError` the rest of core and the api
 * handle, and map the constraint violations they recognise to domain errors.
 * Anything else passes through untouched.
 */
export const toSqlError = (error: EffectDrizzleQueryError): SqlError => {
  const failure = Cause.isCause(error.cause)
    ? Option.getOrUndefined(Cause.findErrorOption(error.cause))
    : error.cause

  return isSqlError(failure)
    ? failure
    : new SqlError({
        reason: new UnknownError({ cause: failure, message: error.message }),
      })
}

/** Run a Drizzle query, failing with `SqlError` instead of Drizzle's wrapper. */
export const query = <A, R>(
  self: Effect.Effect<A, EffectDrizzleQueryError, R>,
): Effect.Effect<A, SqlError, R> => Effect.mapError(self, toSqlError)

/** The violated constraint's name when `error` is a unique violation. */
export const uniqueViolation = (error: SqlError): Option.Option<string> =>
  Predicate.isTagged(error.reason, "UniqueViolation")
    ? Option.some(error.reason.constraint)
    : Option.none()

/**
 * Turn a unique violation on `constraint` into the domain error the
 * repository knows it means. Every other failure stays a `SqlError`.
 */
export const onUniqueViolation =
  <E2>(constraint: string, orFail: () => E2) =>
  <A, R>(
    self: Effect.Effect<A, SqlError, R>,
  ): Effect.Effect<A, SqlError | E2, R> =>
    Effect.catch(self, (error): Effect.Effect<never, SqlError | E2> => {
      const violated = uniqueViolation(error)

      return Option.isSome(violated) && violated.value === constraint
        ? Effect.fail(orFail())
        : Effect.fail(error)
    })
