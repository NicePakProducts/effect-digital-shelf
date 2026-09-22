import { LifecycleErrors } from "./lifecycle/errors"
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Extraction } from "@app/schema/extraction"
import type { ExtractionId, ScrapeId } from "@app/schema/ids"
import { ExtractionsRepo } from "./extractions/repository"
import type { Scrape } from "@app/schema/scrape"
import type {
  ScrapeStatus,
  ExtractionStatus,
} from "@app/schema/scraping-vocabulary"
import * as Effect from "effect/Effect"
import { ScrapesRepo } from "./repository"
import * as Option from "effect/Option"
import { classifyMissedTransition, type TransitionResult } from "./lifecycle"

export * as Transitions from "./transitions"

export interface Interface {
  readonly scrape: (
    id: ScrapeId,
    from: ScrapeStatus,
    to: ScrapeStatus,
    patch: Scrape.UpdateRow,
  ) => Effect.Effect<
    { readonly row: Scrape.Info; readonly result: TransitionResult },
    LifecycleErrors.TransitionRejected | SqlError
  >
  readonly extraction: (
    id: ExtractionId,
    from: ExtractionStatus,
    to: ExtractionStatus,
    patch: Extraction.UpdateRow,
  ) => Effect.Effect<
    { readonly row: Extraction.Info; readonly result: TransitionResult },
    LifecycleErrors.TransitionRejected | SqlError
  >
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/transitions",
) {}

const make = Effect.gen(function* () {
  const scrapesRepo = yield* ScrapesRepo.Service
  const extractionsRepo = yield* ExtractionsRepo.Service

  const scrape = Effect.fn("Scrape.transition")(function* (
    id: ScrapeId,
    from: ScrapeStatus,
    to: ScrapeStatus,
    patch: Scrape.UpdateRow,
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
        new LifecycleErrors.TransitionRejected({
          kind: "scrape",
          id,
          from,
          to,
          observed: Option.getOrNull(Option.map(observed, (row) => row.status)),
        }),
      )

    return { row: observed.value, result }
  })

  const extraction = Effect.fn("Extraction.transition")(function* (
    id: ExtractionId,
    from: ExtractionStatus,
    to: ExtractionStatus,
    patch: Extraction.UpdateRow,
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
      return yield* new LifecycleErrors.TransitionRejected({
        kind: "extraction",
        id,
        from,
        to,
        observed: Option.getOrNull(Option.map(observed, (row) => row.status)),
      })

    return { row: observed.value, result }
  })

  return { scrape, extraction }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([ScrapesRepo.layer, ExtractionsRepo.layer]),
)
