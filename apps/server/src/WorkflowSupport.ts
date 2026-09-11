import type { TransitionRejected } from "@digital-shelf/core/Scraping/Transitions"
import * as Workflows from "alchemy/Cloudflare/Workflows"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpTraceContext from "effect/unstable/http/HttpTraceContext"

export const databaseStep = {
  timeout: "1 minute",
  retries: { limit: 2, delay: "5 seconds" },
} satisfies Workflows.WorkflowStepConfig

export const parentSpan = (traceparent: string) =>
  Option.match(HttpTraceContext.w3c(Headers.fromInput({ traceparent })), {
    onNone: () => Effect.die(new Error("Malformed Workflow traceparent")),
    onSome: (span) => Effect.succeed(Tracer.externalSpan(span)),
  })

export class WorkflowStopped extends Data.TaggedError("WorkflowStopped") {}

/** Catch rejection before Cloudflare flattens errors; persist the stop on replay. */
export const step = <A, E, R>(
  name: string,
  work: Effect.Effect<A, E, R>,
  parent: Tracer.ExternalSpan,
  config: Workflows.WorkflowStepConfig = databaseStep,
) =>
  Effect.gen(function* () {
    const result = yield* Workflows.task(
      name,
      work.pipe(
        Effect.map((value) => ({ _tag: "continue" as const, value })),
        Effect.catchIf(
          (error): error is E & TransitionRejected =>
            typeof error === "object" &&
            error !== null &&
            "_tag" in error &&
            error._tag === "TransitionRejected",
          () => Effect.succeed({ _tag: "stopped" as const }),
        ),
        Effect.orDie,
        Effect.scoped,
        Effect.withParentSpan(parent),
      ),
      config,
    )

    if (result._tag === "stopped") return yield* new WorkflowStopped()

    return result.value
  })
