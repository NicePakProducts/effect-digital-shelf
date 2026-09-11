import {
  Executions,
  ExecutionsError,
  type ExecutionInstance,
} from "@digital-shelf/core/Scheduling/Executions"
import type {
  ExecutionKind,
  ExecutionStatus,
} from "@digital-shelf/domain/Scraping/Execution"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"

interface Call {
  readonly operation: "start" | "status" | "terminate"
  readonly kind: ExecutionKind
  readonly instances: ReadonlyArray<ExecutionInstance>
  readonly id: string | null
}

const make = Effect.gen(function* () {
  const statuses = yield* Ref.make(new Map<string, ExecutionStatus>())
  const calls = yield* Ref.make<ReadonlyArray<Call>>([])
  const failure = yield* Ref.make(false)
  const statusFailures = yield* Ref.make(new Set<string>())
  const terminateFailures = yield* Ref.make(new Set<string>())

  const failStatus = (kind: ExecutionKind, id: string) =>
    Ref.update(statusFailures, (set) => new Set(set).add(`${kind}:${id}`))

  const failTerminate = (kind: ExecutionKind, id: string) =>
    Ref.update(terminateFailures, (set) => new Set(set).add(`${kind}:${id}`))

  const setStatus = (
    kind: ExecutionKind,
    id: string,
    status: ExecutionStatus,
  ) => Ref.update(statuses, (map) => new Map(map).set(`${kind}:${id}`, status))

  const reset = Effect.gen(function* () {
    yield* Ref.set(statuses, new Map())
    yield* Ref.set(calls, [])
    yield* Ref.set(failure, false)
    yield* Ref.set(statusFailures, new Set())
    yield* Ref.set(terminateFailures, new Set())
  })

  const service: Executions["Service"] = {
    start: (kind, instances) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (calls) => [
          ...calls,
          { operation: "start", kind, instances, id: null } satisfies Call,
        ])

        if (yield* Ref.getAndSet(failure, false))
          return yield* Effect.fail(
            new ExecutionsError({
              operation: "start",
              kind,
              cause: "scripted start failure",
            }),
          )

        return yield* Ref.modify(statuses, (map) => {
          const next = new Map(map)

          const started: string[] = [],
            skipped: string[] = []

          for (const instance of instances) {
            if (next.has(`${kind}:${instance.id}`)) skipped.push(instance.id)
            else {
              next.set(`${kind}:${instance.id}`, "queued")
              started.push(instance.id)
            }
          }

          return [{ started, skipped }, next]
        })
      }),
    status: (kind, id) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (calls) => [
          ...calls,
          { operation: "status", kind, instances: [], id } satisfies Call,
        ])

        if ((yield* Ref.get(statusFailures)).has(`${kind}:${id}`))
          return yield* Effect.fail(
            new ExecutionsError({
              operation: "status",
              kind,
              cause: "scripted status failure",
            }),
          )

        return Option.fromUndefinedOr(
          (yield* Ref.get(statuses)).get(`${kind}:${id}`),
        )
      }),
    terminate: (kind, id) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (calls) => [
          ...calls,
          { operation: "terminate", kind, instances: [], id } satisfies Call,
        ])

        if ((yield* Ref.get(terminateFailures)).has(`${kind}:${id}`))
          return yield* Effect.fail(
            new ExecutionsError({
              operation: "terminate",
              kind,
              cause: "scripted termination failure",
            }),
          )
        yield* setStatus(kind, id, "terminated")
      }),
  }

  return {
    service,
    setStatus,
    failStatus,
    failTerminate,
    calls: Ref.get(calls),
    failNext: Ref.set(failure, true),
    reset,
  }
})

export class ExecutionsTest extends Context.Service<
  ExecutionsTest,
  Effect.Success<typeof make>
>()("test/Executions", { make }) {}

const inspection = Layer.effect(ExecutionsTest, ExecutionsTest.make)

export const layerTest = Layer.effect(
  Executions,
  Effect.map(ExecutionsTest, (test) => test.service),
).pipe(Layer.provideMerge(inspection))
