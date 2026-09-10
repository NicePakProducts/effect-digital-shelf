import {
  Executions,
  ExecutionsError,
  startBatchLimit,
  type ExecutionInstance,
  type StartReport,
} from "@digital-shelf/core/Scheduling/Executions"
import {
  ExecutionStatus,
  type ExecutionKind,
} from "@digital-shelf/domain/Scraping/Execution"
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

/** Alchemy uses tryPromise(...).orDie: RPC errors arrive inside UnknownError.cause. */
const matches = (defect: unknown, pattern: RegExp): boolean => {
  const seen = new Set<unknown>()
  let current = defect
  while (!seen.has(current)) {
    seen.add(current)
    if (typeof current === "string") return pattern.test(current)
    if (typeof current !== "object" || current === null) return false
    if (
      "message" in current &&
      typeof current.message === "string" &&
      pattern.test(current.message)
    )
      return true
    if (!("cause" in current)) return false
    current = current.cause
  }
  return false
}

const duplicate = (defect: unknown) =>
  matches(
    defect,
    /\binstance\.(?:already_exists|id_conflict)\b|\b(?:instance|id)\b[^\n]*\balready (?:exists|in use|used)\b/i,
  )
const notFound = (defect: unknown) =>
  matches(
    defect,
    /\binstance\.not_found\b|\binstance\b[^\n]*\b(?:not found|does not exist)\b/i,
  )
const terminal = (defect: unknown) =>
  matches(
    defect,
    /\binstance\.cannot_terminate\b|\binstance\b[^\n]*\balready (?:terminal|terminated|complete|completed|errored)\b/i,
  )

const start = <Params>(
  kind: ExecutionKind,
  handle: WorkflowHandle<Params>,
  batch: CreateOptions<Params>[],
): Effect.Effect<StartReport, ExecutionsError> => {
  const error = (cause: unknown) =>
    new ExecutionsError({ operation: "start", kind, cause })
  return Effect.suspend(() => handle.createBatch(batch)).pipe(
    Effect.map((created) => {
      const ids = new Set(created.map(({ id }) => id))
      return {
        started: batch.filter(({ id }) => ids.has(id)).map(({ id }) => id),
        skipped: batch.filter(({ id }) => !ids.has(id)).map(({ id }) => id),
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
              if (created) started.push(options.id)
              else skipped.push(options.id)
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
    Executions,
    Executions.of({
      start: Effect.fn("Executions.start")(function* (
        kind: ExecutionKind,
        instances: ReadonlyArray<ExecutionInstance>,
      ) {
        yield* Effect.annotateCurrentSpan("shelf.execution.kind", kind)
        if (instances.length > startBatchLimit)
          return yield* Effect.fail(
            new ExecutionsError({
              operation: "start",
              kind,
              cause: `At most ${startBatchLimit} instances may be started in one batch`,
            }),
          )
        if (instances.length === 0) return { started: [], skipped: [] }
        // Report by id, matching the single-use identity contract even if an input
        // contains an id twice. Keep the first trace context for that id.
        const seen = new Set<string>()
        const unique = instances.filter(({ id }) => {
          if (seen.has(id)) return false
          seen.add(id)
          return true
        })
        return yield* kind === "scrape"
          ? start(
              kind,
              handles.scrape,
              unique.map(({ id, traceparent }) => ({
                id,
                params: { scrapeId: id, traceparent },
              })),
            )
          : start(
              kind,
              handles.extraction,
              unique.map(({ id, traceparent }) => ({
                id,
                params: { extractionId: id, traceparent },
              })),
            )
      }),
      status: Effect.fn("Executions.status")(function* (
        kind: ExecutionKind,
        id: string,
      ) {
        yield* Effect.annotateCurrentSpan("shelf.execution.kind", kind)
        return yield* Effect.gen(function* () {
          const instance = yield* handles[kind].get(id)
          const { status } = yield* instance.status()
          return Option.some(
            Option.getOrElse(
              Schema.decodeUnknownOption(ExecutionStatus)(status),
              () => "unknown" as const,
            ),
          )
        }).pipe(
          Effect.catchDefect((cause) =>
            notFound(cause)
              ? Effect.succeed(Option.none())
              : Effect.fail(
                  new ExecutionsError({ operation: "status", kind, cause }),
                ),
          ),
        )
      }),
      terminate: Effect.fn("Executions.terminate")(function* (
        kind: ExecutionKind,
        id: string,
      ) {
        yield* Effect.annotateCurrentSpan("shelf.execution.kind", kind)
        return yield* Effect.gen(function* () {
          const instance = yield* handles[kind].get(id)
          yield* instance.terminate()
        }).pipe(
          Effect.catchDefect((cause) =>
            notFound(cause) || terminal(cause)
              ? Effect.void
              : Effect.fail(
                  new ExecutionsError({ operation: "terminate", kind, cause }),
                ),
          ),
        )
      }),
    }),
  )
