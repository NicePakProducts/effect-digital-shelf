import * as Schema from "effect/Schema"

/**
 * The vocabulary of Executions and dispatch (CONTEXT.md, "Execution and
 * dispatch"). An Execution is the durable unit of work that carries out one
 * Scrape or one Extraction; its status is distinct from the row's status and
 * only a confirmed terminal status ever moves a row.
 */

export const ExecutionKinds = ["scrape", "extraction"] as const

export const ExecutionKind = Schema.Literals(ExecutionKinds)

export type ExecutionKind = typeof ExecutionKind.Type

export const ActiveExecutionStatuses = [
  "queued",
  "running",
  "waiting",
  "paused",
  "waitingForPause",
] as const

export const TerminalExecutionStatuses = [
  "complete",
  "errored",
  "terminated",
] as const

export const UnresolvedExecutionStatuses = ["unknown"] as const

export const ExecutionStatuses = [
  ...ActiveExecutionStatuses,
  ...TerminalExecutionStatuses,
  ...UnresolvedExecutionStatuses,
] as const

export const ExecutionStatus = Schema.Literals(ExecutionStatuses)

export type ExecutionStatus = typeof ExecutionStatus.Type

export const isTerminalExecutionStatus = (
  status: ExecutionStatus,
): status is (typeof TerminalExecutionStatuses)[number] =>
  TerminalExecutionStatuses.some((candidate) => candidate === status)

export const isActiveExecutionStatus = (
  status: ExecutionStatus,
): status is (typeof ActiveExecutionStatuses)[number] =>
  ActiveExecutionStatuses.some((candidate) => candidate === status)

/** The result of a Dispatch, as a value rather than an exception. */
export const DispatchOutcomes = [
  "created",
  "in-flight-skip",
  "already-active",
  "recovered-failed",
] as const

export const DispatchOutcome = Schema.Literals(DispatchOutcomes)

export type DispatchOutcome = typeof DispatchOutcome.Type

/**
 * The span id of the `Scrape.created` root span, stored on the row so every
 * later span of the Scrape can parent onto it (ADR 0007). Sixteen lower-case
 * hex characters, as OpenTelemetry defines a span id.
 */
export const SpanId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{16}$/, {
    identifier: "SpanId",
    description: "a 16-character lower-case hex span id",
  }),
)

export type SpanId = typeof SpanId.Type
