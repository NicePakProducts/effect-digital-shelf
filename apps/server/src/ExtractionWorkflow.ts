import { ExtractionRunner } from "@digital-shelf/core/Scraping/ExtractionRunner"
import { ExtractionId } from "@digital-shelf/domain/Shared/Ids"
import { ExtractionParams } from "@digital-shelf/infra/Adapters/Executions"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { WorkflowLayers } from "./WorkflowLayers.ts"
import { parentSpan, step } from "./WorkflowSupport.ts"

export const run = <E, R>(
  input: ExtractionParams,
  layer: Layer.Layer<ExtractionRunner, E, R>,
) =>
  Effect.gen(function* () {
    // SAFETY: infra's Adapters/Executions.ts encodes these params and their id;
    // a decode failure is a bug in this codebase's encoder, not external input.
    const params = yield* Schema.decodeUnknownEffect(ExtractionParams)(
      input,
    ).pipe(Effect.orDie)

    const id = yield* Schema.decodeUnknownEffect(ExtractionId)(
      params.extractionId,
    ).pipe(Effect.orDie)

    const parent = yield* parentSpan(params.traceparent)

    const claim = Effect.fn("ExtractionWorkflow.claim")(function* () {
      const runner = yield* ExtractionRunner

      return yield* runner.claim(id)
    })

    const sequence = Effect.gen(function* () {
      const target = yield* step(
        "claim",
        claim().pipe(Effect.provide(layer)),
        parent,
      )

      const extract = Effect.fn("ExtractionWorkflow.extract")(function* () {
        const runner = yield* ExtractionRunner

        return yield* runner.extract(id, target)
      })

      const outcome = yield* step(
        "extract",
        extract().pipe(Effect.provide(layer)),
        parent,
        {
          timeout: "3 minutes",
          retries: { limit: 0, delay: "1 second" },
        },
      )

      const finish = Effect.fn("ExtractionWorkflow.finish")(function* () {
        const runner = yield* ExtractionRunner
        yield* runner.finish(id, outcome)

        return null
      })

      yield* step("finish", finish().pipe(Effect.provide(layer)), parent)
    })

    return yield* sequence.pipe(
      Effect.catchTag("WorkflowStopped", () => Effect.void),
      Effect.catchCause((cause) => {
        const fail = Effect.fn("ExtractionWorkflow.fail")(function* () {
          const runner = yield* ExtractionRunner
          yield* runner.fail(
            id,
            "unknown",
            "Extraction Workflow execution failed",
          )

          return null
        })

        return step("fail", fail().pipe(Effect.provide(layer)), parent).pipe(
          Effect.catchTag("WorkflowStopped", () => Effect.void),
          Effect.andThen(Effect.failCause(cause)),
        )
      }),
      // Run spans stay outside step telemetry and are intentionally unexported.
      Effect.withSpan("ExtractionWorkflow.run", { parent }),
    )
  })

export class ExtractionWorkflow extends Cloudflare.Workflow<ExtractionWorkflow>()(
  "ExtractionWorkflow",
  Effect.gen(function* () {
    const layers = yield* WorkflowLayers

    return (input: ExtractionParams) => run(input, layers.extraction)
  }),
) {}
