import {
  Executions,
  ExecutionsError,
  startBatchLimit,
  type StartExecutionsInput,
  type ExecutionStatusInput,
  type TerminateExecutionInput,
  type StartReport,
} from "@app/core/executions"
import { Execution } from "@app/schema/execution"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

export const ScrapeParams = Schema.Struct({
  scrapeId: Schema.String,
  traceparent: Schema.String,
})

export type ScrapeParams = typeof ScrapeParams.Type

export const ExtractionParams = Schema.Struct({
  extractionId: Schema.String,
  traceparent: Schema.String,
})

export type ExtractionParams = typeof ExtractionParams.Type

interface CreateOptions<Params> {
  readonly id: string
  readonly params: Params
}

export interface WorkflowInstance {
  readonly id: string
  readonly status: () => Effect.Effect<{ readonly status: string }>
  readonly terminate: () => Effect.Effect<void>
}

/** Effect-native handles yielded by the Workflow classes in apps/server. */
export interface WorkflowHandle<Params> {
  readonly createBatch: (
    batch: CreateOptions<Params>[],
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>>
  readonly create: (
    options: CreateOptions<Params>,
  ) => Effect.Effect<{ readonly id: string }>
  readonly get: (id: string) => Effect.Effect<WorkflowInstance>
}

const RpcError = Schema.Struct({
  message: Schema.optional(Schema.Unknown),
  cause: Schema.optional(Schema.Unknown),
})

/** Alchemy uses tryPromise(...).orDie: RPC errors arrive inside UnknownError.cause. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Effect defects from Alchemy RPC are unknown; this boundary decodes each error in the cause chain.
const matches = (defect: unknown, pattern: RegExp): boolean => {
  const seen = new Set<unknown>()

  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- each node is one link of the unknown RPC cause chain, decoded below.
  const visit = (node: unknown): boolean => {
    if (seen.has(node)) return false
    seen.add(node)

    const text = Schema.decodeUnknownOption(Schema.String)(node)

    if (Option.isSome(text)) return pattern.test(text.value)

    const error = Schema.decodeUnknownOption(RpcError)(node)

    if (Option.isNone(error)) return false

    const message = Schema.decodeUnknownOption(Schema.String)(
      error.value.message,
    )

    if (Option.isSome(message) && pattern.test(message.value)) return true

    return visit(error.value.cause)
  }

  return visit(defect)
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Alchemy's catchDefect contract supplies unknown; matches decodes the RPC cause chain.
const duplicate = (defect: unknown) =>
  matches(
    defect,
    /\binstance\.(?:already_exists|id_conflict)\b|\b(?:instance|id)\b[^\n]*\balready (?:exists|in use|used)\b/i,
  )

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Alchemy's catchDefect contract supplies unknown; matches decodes the RPC cause chain.
const notFound = (defect: unknown) =>
  matches(
    defect,
    /\binstance\.not_found\b|\binstance\b[^\n]*\b(?:not found|does not exist)\b/i,
  )

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Alchemy's catchDefect contract supplies unknown; matches decodes the RPC cause chain.
const terminal = (defect: unknown) =>
  matches(
    defect,
    /\binstance\.cannot_terminate\b|\binstance\b[^\n]*\balready (?:terminal|terminated|complete|completed|errored)\b/i,
  )

const start = <Params>(
  kind: Execution.Kind,
  handle: WorkflowHandle<Params>,
  batch: CreateOptions<Params>[],
): Effect.Effect<StartReport, ExecutionsError> => {
  const error = (cause: unknown) =>
    new ExecutionsError({ operation: "start", kind, cause })

  return Effect.suspend(() => handle.createBatch(batch)).pipe(
    Effect.map((created) => {
      const ids = new Set(created.map(({ id }) => id))

      return {
        started: batch.flatMap(({ id }) => (ids.has(id) ? [id] : [])),
        skipped: batch.flatMap(({ id }) => (ids.has(id) ? [] : [id])),
      }
    }),
    // Live docs say duplicates are omitted; the installed workers-types
    // comment says they throw. Support that older behavior without restarting.
    Effect.catchDefect((cause) =>
      duplicate(cause)
        ? Effect.gen(function* () {
            const started: string[] = [],
              skipped: string[] = []

            for (const options of batch) {
              const created = yield* Effect.suspend(() =>
                handle.create(options),
              ).pipe(
                Effect.as(true),
                Effect.catchDefect((cause) =>
                  duplicate(cause)
                    ? Effect.succeed(false)
                    : Effect.fail(error(cause)),
                ),
              )

              ;(created ? started : skipped).push(options.id)
            }

            return { started, skipped }
          })
        : Effect.fail(error(cause)),
    ),
  )
}

export const layer = (handles: {
  readonly scrape: WorkflowHandle<ScrapeParams>
  readonly extraction: WorkflowHandle<ExtractionParams>
}) =>
  Layer.succeed(
    Executions.Service,
    Executions.Service.of({
      start: Effect.fn("Executions.start")(function* (
        input: StartExecutionsInput,
      ) {
        yield* Effect.annotateCurrentSpan("shelf.execution.kind", input.kind)

        if (input.instances.length > startBatchLimit)
          return yield* Effect.fail(
            new ExecutionsError({
              operation: "start",
              kind: input.kind,
              cause: `At most ${startBatchLimit} instances may be started in one batch`,
            }),
          )

        if (input.instances.length === 0) return { started: [], skipped: [] }
        // Report by id, matching the single-use identity contract even if an input
        // contains an id twice. Keep the first trace context for that id.
        const seen = new Set<string>()

        const unique = input.instances.filter(({ id }) => {
          if (seen.has(id)) return false
          seen.add(id)

          return true
        })

        return yield* input.kind === "scrape"
          ? start(
              input.kind,
              handles.scrape,
              unique.map(({ id, traceparent }) => ({
                id,
                params: { scrapeId: id, traceparent },
              })),
            )
          : start(
              input.kind,
              handles.extraction,
              unique.map(({ id, traceparent }) => ({
                id,
                params: { extractionId: id, traceparent },
              })),
            )
      }),
      status: Effect.fn("Executions.status")(function* (
        input: ExecutionStatusInput,
      ) {
        yield* Effect.annotateCurrentSpan("shelf.execution.kind", input.kind)

        return yield* Effect.gen(function* () {
          const instance = yield* handles[input.kind].get(input.id)
          const report = yield* instance.status()

          return Option.some(
            Option.getOrElse(
              Schema.decodeUnknownOption(Execution.Status)(report.status),
              () => "unknown" as const,
            ),
          )
        }).pipe(
          Effect.catchDefect((cause) =>
            notFound(cause)
              ? Effect.succeed(Option.none())
              : Effect.fail(
                  new ExecutionsError({
                    operation: "status",
                    kind: input.kind,
                    cause,
                  }),
                ),
          ),
        )
      }),
      terminate: Effect.fn("Executions.terminate")(function* (
        input: TerminateExecutionInput,
      ) {
        yield* Effect.annotateCurrentSpan("shelf.execution.kind", input.kind)

        return yield* Effect.gen(function* () {
          const instance = yield* handles[input.kind].get(input.id)
          yield* instance.terminate()
        }).pipe(
          Effect.catchDefect((cause) =>
            notFound(cause) || terminal(cause)
              ? Effect.void
              : Effect.fail(
                  new ExecutionsError({
                    operation: "terminate",
                    kind: input.kind,
                    cause,
                  }),
                ),
          ),
        )
      }),
    }),
  )
