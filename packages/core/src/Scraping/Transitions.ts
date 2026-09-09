import type { LifecycleStatuses } from "@digital-shelf/domain/Scraping/Vocabulary"
import * as Option from "effect/Option"

/**
 * The lifecycle shared by Scrapes and Extractions: `pending → running →
 * success | failed`, terminal states final. Every transition is a
 * conditional update on the expected source status (ADR 0004); when it
 * updates nothing, the writer re-reads the row and this table says whether
 * an earlier run of the same step already applied it or the row moved
 * elsewhere.
 */

export type LifecycleStatus = (typeof LifecycleStatuses)[number]

export const transitions: Record<
  LifecycleStatus,
  ReadonlyArray<LifecycleStatus>
> = {
  pending: ["running", "failed"],
  running: ["success", "failed"],
  success: [],
  failed: [],
}

export const isTerminal = (status: LifecycleStatus): boolean =>
  transitions[status].length === 0

export const canTransition = (
  from: LifecycleStatus,
  to: LifecycleStatus,
): boolean => transitions[from].includes(to)

/**
 * `applied`: this write moved the row. `already_applied`: the row was
 * already in the target state, so an earlier run of the same step did it
 * and the step may continue. `rejected`: another writer moved the row
 * elsewhere (or it is gone); the step stops and undoes its own side effects.
 * Recorded on every transition span as `shelf.transition` (ADR 0007).
 */
export type TransitionResult = "applied" | "already_applied" | "rejected"

export const classifyMissedTransition = (
  target: LifecycleStatus,
  observed: Option.Option<LifecycleStatus>,
): Exclude<TransitionResult, "applied"> =>
  Option.isSome(observed) && observed.value === target
    ? "already_applied"
    : "rejected"
