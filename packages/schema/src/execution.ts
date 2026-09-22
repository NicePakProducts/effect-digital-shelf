import * as Schema from "effect/Schema"

export * as Execution from "./execution"

/**
 * The vocabulary of Executions and dispatch (CONTEXT.md, "Execution and
 * dispatch"). An Execution is the durable unit of work that carries out one
 * Scrape or one Extraction; its status is distinct from the row's status and
 * only a confirmed terminal status ever moves a row.
 */

export const Kinds = ["scrape", "extraction"] as const

export const Kind = Schema.Literals(Kinds)

export type Kind = typeof Kind.Type

export const ActiveStatuses = [
  "queued",
  "running",
  "waiting",
  "paused",
  "waitingForPause",
] as const

export const TerminalStatuses = ["complete", "errored", "terminated"] as const

export const UnresolvedStatuses = ["unknown"] as const

export const Statuses = [
  ...ActiveStatuses,
  ...TerminalStatuses,
  ...UnresolvedStatuses,
] as const

export const Status = Schema.Literals(Statuses)

export type Status = typeof Status.Type

export const isTerminalStatus = (
  status: Status,
): status is (typeof TerminalStatuses)[number] =>
  TerminalStatuses.some((candidate) => candidate === status)

export const isActiveStatus = (
  status: Status,
): status is (typeof ActiveStatuses)[number] =>
  ActiveStatuses.some((candidate) => candidate === status)

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
