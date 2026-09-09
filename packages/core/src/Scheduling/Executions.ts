import type {
  ExecutionKind,
  ExecutionStatus,
} from "@digital-shelf/domain/Scraping/Execution"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as Option from "effect/Option"

/**
 * The port over the durable Executions that carry out Scrapes and
 * Extractions. Core defines it; infra satisfies it over the two Cloudflare
 * Workflow bindings (ADR 0006) and never leaks their types here. An
 * Execution's identity is the row id, single-use: `start` on an id already
 * used reports it `skipped`, and the caller reconciles the row from
 * `status` (ADR 0004).
 */

export interface ExecutionInstance {
  /** The Scrape or Extraction id the Execution carries out. */
  readonly id: string
  /** W3C trace context of the Scrape's root span (ADR 0007). */
  readonly traceparent: string
}

export interface StartReport {
  readonly started: ReadonlyArray<string>
  /** Ids whose Execution already existed, whatever its status. */
  readonly skipped: ReadonlyArray<string>
}

export class ExecutionsError extends Data.TaggedError("ExecutionsError")<{
  readonly operation: "start" | "status" | "terminate"
  readonly kind: ExecutionKind
  readonly cause: unknown
}> {}

export class Executions extends Context.Service<
  Executions,
  {
    /** One batch start, at most 100 instances; idempotent on used ids. */
    readonly start: (
      kind: ExecutionKind,
      instances: ReadonlyArray<ExecutionInstance>,
    ) => Effect.Effect<StartReport, ExecutionsError>
    /** `None` when no Execution exists under that id. */
    readonly status: (
      kind: ExecutionKind,
      id: string,
    ) => Effect.Effect<Option.Option<ExecutionStatus>, ExecutionsError>
    /** Best effort: an unknown or already terminal Execution is not an error. */
    readonly terminate: (
      kind: ExecutionKind,
      id: string,
    ) => Effect.Effect<void, ExecutionsError>
  }
>()("@digital-shelf/core/Scheduling/Executions") {}

/** `createBatch` accepts at most this many instances per call. */
export const startBatchLimit = 100
