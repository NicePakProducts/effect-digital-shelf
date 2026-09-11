import * as Workflows from "alchemy/Cloudflare/Workflows"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Tracer from "effect/Tracer"
import * as Headers from "effect/unstable/http/Headers"
import * as HttpTraceContext from "effect/unstable/http/HttpTraceContext"

export const databaseStep = {
  timeout: "1 minute",
  retries: { limit: 2, delay: "5 seconds" },
} satisfies Workflows.WorkflowStepConfig

export const parentSpan = (traceparent: string) =>
  Option.match(HttpTraceContext.w3c(Headers.fromInput({ traceparent })), {
    // SAFETY: this codebase encodes Workflow traceparents; malformed context is a bug.
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
        Effect.catchIf(Predicate.isTagged("TransitionRejected"), () =>
          Effect.succeed({ _tag: "stopped" as const }),
        ),
        // Workflows.task takes E = never: TransitionRejected is the one failure a step
        // handles as a value (the stop above); every other typed failure, a SqlError, a
        // provider failure or a ConfigError from building the step's layer inside this
        // body, crosses into the Workflow runtime as the step's error, where
        // config.retries governs it and an exhausted step errors the instance.
        Effect.orDie,
        Effect.scoped,
        Effect.withParentSpan(parent),
      ),
      config,
    )

    if (Predicate.isTagged(result, "stopped"))
      return yield* new WorkflowStopped()

    return result.value
  })
