import { ScrapeRunner } from "@digital-shelf/core/Scraping/ScrapeRunner"
import { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import { ScrapeParams } from "@digital-shelf/infra/Adapters/Executions"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { WorkflowLayers } from "./WorkflowLayers.ts"
import { parentSpan, step } from "./WorkflowSupport.ts"

export const run = <E, R>(
  input: ScrapeParams,
  layer: Layer.Layer<ScrapeRunner, E, R>,
) =>
  Effect.gen(function* () {
    // SAFETY: infra's Adapters/Executions.ts encodes these params and their id;
    // a decode failure is a bug in this codebase's encoder, not external input.
    const params = yield* Schema.decodeUnknownEffect(ScrapeParams)(input).pipe(
      Effect.orDie,
    )

    const id = yield* Schema.decodeUnknownEffect(ScrapeId)(
      params.scrapeId,
    ).pipe(Effect.orDie)

    const parent = yield* parentSpan(params.traceparent)

    const claim = Effect.fn("ScrapeWorkflow.claim")(function* () {
      const runner = yield* ScrapeRunner

      return yield* runner.claim(id)
    })

    const sequence = Effect.gen(function* () {
      const target = yield* step(
        "claim",
        claim().pipe(Effect.provide(layer)),
        parent,
      )

      const fetch = Effect.fn("ScrapeWorkflow.fetch")(function* () {
        const runner = yield* ScrapeRunner

        return yield* runner.fetch(id, target)
      })

      const outcome = yield* step(
        "fetch",
        fetch().pipe(Effect.provide(layer)),
        parent,
        {
          timeout: "4 minutes",
          retries: { limit: 0, delay: "1 second" },
        },
      )

      const finish = Effect.fn("ScrapeWorkflow.finish")(function* () {
        const runner = yield* ScrapeRunner

        return yield* runner.finish(id, outcome)
      })

      const finished = yield* step(
        "finish",
        finish().pipe(Effect.provide(layer)),
        parent,
      )

      if (finished.extractionId !== null) {
        const extractionId = finished.extractionId

        const start = Effect.fn("ScrapeWorkflow.startExtraction")(function* () {
          const runner = yield* ScrapeRunner
          yield* runner.startExtraction(extractionId, id)

          return null
        })

        yield* step(
          "startExtraction",
          start().pipe(Effect.provide(layer)),
          parent,
        )
      }
    })

    return yield* sequence.pipe(
      Effect.catchTag("WorkflowStopped", () => Effect.void),
      Effect.catchCause((cause) => {
        const fail = Effect.fn("ScrapeWorkflow.fail")(function* () {
          const runner = yield* ScrapeRunner
          yield* runner.fail(id, "unknown", "Scrape Workflow execution failed")

          return null
        })

        return step("fail", fail().pipe(Effect.provide(layer)), parent).pipe(
          Effect.catchTag("WorkflowStopped", () => Effect.void),
          Effect.andThen(Effect.failCause(cause)),
        )
      }),
      // Run spans stay outside step telemetry and are intentionally unexported.
      Effect.withSpan("ScrapeWorkflow.run", { parent }),
    )
  })

export class ScrapeWorkflow extends Cloudflare.Workflow<ScrapeWorkflow>()(
  "ScrapeWorkflow",
  Effect.gen(function* () {
    const layers = yield* WorkflowLayers

    return (input: ScrapeParams) => run(input, layers.scrape)
  }),
) {}
