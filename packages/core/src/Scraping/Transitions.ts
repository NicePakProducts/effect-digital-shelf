import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type {
  Extraction,
  ExtractionUpdate,
} from "@digital-shelf/domain/Scraping/Extraction"
import type { ExtractionId } from "@digital-shelf/domain/Shared/Ids"
import { ExtractionsRepo } from "./repositories/ExtractionsRepo.ts"
import type {
  Scrape,
  ScrapeUpdate,
} from "@digital-shelf/domain/Scraping/Scrape"
import type {
  ScrapeStatus,
  ExtractionStatus,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import type { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { ScrapesRepo } from "./repositories/ScrapesRepo.ts"

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

export class TransitionRejected extends Data.TaggedError("TransitionRejected")<{
  readonly kind: "scrape" | "extraction"
  readonly id: string
  readonly from: LifecycleStatus
  readonly to: LifecycleStatus
  readonly observed: LifecycleStatus | null
}> {}

export class Transitions extends Context.Service<
  Transitions,
  {
    readonly scrape: (
      id: ScrapeId,
      from: ScrapeStatus,
      to: ScrapeStatus,
      patch: ScrapeUpdate,
    ) => Effect.Effect<
      { readonly row: Scrape; readonly result: TransitionResult },
      TransitionRejected | SqlError
    >
    readonly extraction: (
      id: ExtractionId,
      from: ExtractionStatus,
      to: ExtractionStatus,
      patch: ExtractionUpdate,
    ) => Effect.Effect<
      { readonly row: Extraction; readonly result: TransitionResult },
      TransitionRejected | SqlError
    >
  }
>()("@digital-shelf/core/Scraping/Transitions", {
  make: Effect.gen(function* () {
    const scrapesRepo = yield* ScrapesRepo
    const extractionsRepo = yield* ExtractionsRepo

    const scrape = Effect.fn("Scrape.transition")(function* (
      id: ScrapeId,
      from: ScrapeStatus,
      to: ScrapeStatus,
      patch: ScrapeUpdate,
    ) {
      const changed = yield* scrapesRepo.transition(id, from, to, patch)

      const observed = Option.isSome(changed)
        ? changed
        : yield* scrapesRepo.find(id)

      const result: TransitionResult = Option.isSome(changed)
        ? "applied"
        : classifyMissedTransition(
            to,
            Option.map(observed, (row) => row.status),
          )

      yield* Effect.annotateCurrentSpan({
        "shelf.transition": result,
        "shelf.transition.from": from,
        "shelf.transition.to": to,
      })

      if (result === "rejected" || Option.isNone(observed))
        return yield* Effect.fail(
          new TransitionRejected({
            kind: "scrape",
            id,
            from,
            to,
            observed: Option.getOrNull(
              Option.map(observed, (row) => row.status),
            ),
          }),
        )

      return { row: observed.value, result }
    })

    const extraction = Effect.fn("Extraction.transition")(function* (
      id: ExtractionId,
      from: ExtractionStatus,
      to: ExtractionStatus,
      patch: ExtractionUpdate,
    ) {
      const changed = yield* extractionsRepo.transition(id, from, to, patch)

      const observed = Option.isSome(changed)
        ? changed
        : yield* extractionsRepo.find(id)

      const result: TransitionResult = Option.isSome(changed)
        ? "applied"
        : classifyMissedTransition(
            to,
            Option.map(observed, (row) => row.status),
          )

      yield* Effect.annotateCurrentSpan({
        "shelf.transition": result,
        "shelf.transition.from": from,
        "shelf.transition.to": to,
      })

      if (result === "rejected" || Option.isNone(observed))
        return yield* new TransitionRejected({
          kind: "extraction",
          id,
          from,
          to,
          observed: Option.getOrNull(Option.map(observed, (row) => row.status)),
        })

      return { row: observed.value, result }
    })

    return { scrape, extraction }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([ScrapesRepo.layer, ExtractionsRepo.layer]),
  )
}
