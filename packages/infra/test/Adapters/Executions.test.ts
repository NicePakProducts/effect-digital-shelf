import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import {
  Executions,
  ExecutionsError,
} from "@digital-shelf/core/Scheduling/Executions"
import {
  ExecutionStatuses,
  type ExecutionKind,
} from "@digital-shelf/domain/Scraping/Execution"
import * as Adapter from "@digital-shelf/infra/Adapters/Executions"
import type { WorkflowHandle } from "alchemy/Cloudflare/Workflows"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const traceparent = "00-00000000000040008000000000000001-0123456789abcdef-01"
const request = (id: string) => ({ id, traceparent })
const rpcDefect = (message: string) =>
  new Cause.UnknownError(new Error(message))
const missing = rpcDefect("instance.not_found")
const duplicate = rpcDefect("Workflow instance with this id already exists")

const fake = <Params>() => {
  const states = new Map<string, string>()
  const calls: { operation: string; input: unknown }[] = []
  const handle: Adapter.WorkflowHandle<Params> = {
    createBatch: (batch) =>
      Effect.sync(() => {
        calls.push({ operation: "createBatch", input: batch })
        return batch.flatMap(({ id }) => {
          if (states.has(id)) return []
          states.set(id, "queued")
          return [{ id }]
        })
      }),
    create: ({ id, params }) =>
      Effect.suspend(() => {
        calls.push({ operation: "create", input: { id, params } })
        if (states.has(id)) return Effect.die(duplicate)
        states.set(id, "queued")
        return Effect.succeed({ id })
      }),
    get: (id) =>
      Effect.suspend(() => {
        calls.push({ operation: "get", input: id })
        if (!states.has(id)) return Effect.die(missing)
        return Effect.succeed({
          id,
          status: () =>
            Effect.sync(() => ({ status: states.get(id) ?? "unknown" })),
          terminate: () =>
            Effect.sync(() => {
              states.set(id, "terminated")
            }),
        })
      }),
  }
  return { handle, calls, states }
}

const setup = () => {
  const scrape = fake<Adapter.ScrapeParams>()
  const extraction = fake<Adapter.ExtractionParams>()
  return {
    scrape,
    extraction,
    handles: { scrape: scrape.handle, extraction: extraction.handle },
  }
}

describe("Executions adapter", () => {
  it("accepts Alchemy handles and shares JSON params with the Workflow classes", () => {
    expectTypeOf<WorkflowHandle<Adapter.ScrapeParams>>().toExtend<
      Adapter.WorkflowHandle<Adapter.ScrapeParams>
    >()
    expectTypeOf<WorkflowHandle<Adapter.ExtractionParams>>().toExtend<
      Adapter.WorkflowHandle<Adapter.ExtractionParams>
    >()
    expect(
      Schema.decodeUnknownSync(Adapter.ScrapeParams)({
        scrapeId: "one",
        traceparent,
      }),
    ).toEqual({ scrapeId: "one", traceparent })
    expect(
      Schema.decodeUnknownSync(Adapter.ExtractionParams)({
        extractionId: "two",
        traceparent,
      }),
    ).toEqual({ extractionId: "two", traceparent })
  })

  for (const kind of ["scrape", "extraction"] as const) {
    it.effect(
      `starts ${kind} batches and reports existing IDs as skipped`,
      () => {
        const env = setup()
        env[kind].states.set("old", "complete")
        return Effect.gen(function* () {
          const executions = yield* Executions
          expect(
            yield* executions.start(kind, [
              request("one"),
              request("old"),
              request("two"),
            ]),
          ).toEqual({ started: ["one", "two"], skipped: ["old"] })
          expect(env[kind].calls).toEqual([
            {
              operation: "createBatch",
              input: ["one", "old", "two"].map((id) => ({
                id,
                params:
                  kind === "scrape"
                    ? { scrapeId: id, traceparent }
                    : { extractionId: id, traceparent },
              })),
            },
          ])
          expect(
            env[kind === "scrape" ? "extraction" : "scrape"].calls,
          ).toEqual([])
          expect(
            yield* executions.start(kind, [request("one"), request("old")]),
          ).toEqual({ started: [], skipped: ["one", "old"] })
        }).pipe(Effect.provide(Adapter.layer(env.handles)))
      },
    )
  }

  it.effect("reports by id even if the batch result is reordered", () => {
    const env = setup()
    return Effect.gen(function* () {
      const executions = yield* Executions
      expect(
        yield* executions.start("scrape", [
          request("a"),
          request("old"),
          request("b"),
        ]),
      ).toEqual({ started: ["a", "b"], skipped: ["old"] })
    }).pipe(
      Effect.provide(
        Adapter.layer({
          ...env.handles,
          scrape: {
            ...env.handles.scrape,
            createBatch: () => Effect.succeed([{ id: "b" }, { id: "a" }]),
          },
        }),
      ),
    )
  })

  it.effect(
    "falls back after a duplicate batch defect, including a partially created batch",
    () => {
      const env = setup()
      env.scrape.states.set("old", "complete")
      return Effect.gen(function* () {
        const executions = yield* Executions
        expect(
          yield* executions.start("scrape", [
            request("old"),
            request("partial"),
            request("new"),
          ]),
        ).toEqual({ started: ["new"], skipped: ["old", "partial"] })
        expect(env.scrape.states.get("old")).toBe("complete")
        expect(env.scrape.states.get("new")).toBe("queued")
        expect(env.scrape.calls.map(({ operation }) => operation)).toEqual([
          "create",
          "create",
          "create",
        ])
      }).pipe(
        Effect.provide(
          Adapter.layer({
            ...env.handles,
            scrape: {
              ...env.handles.scrape,
              createBatch: () =>
                Effect.suspend(() => {
                  env.scrape.states.set("partial", "queued")
                  return Effect.die(duplicate)
                }),
            },
          }),
        ),
      )
    },
  )

  it.effect("does not fall back on other batch failures", () => {
    const env = setup()
    const cause = rpcDefect("workflow not found in env")
    return Effect.gen(function* () {
      const executions = yield* Executions
      expect(
        yield* Effect.flip(executions.start("scrape", [request("one")])),
      ).toEqual(
        new ExecutionsError({ operation: "start", kind: "scrape", cause }),
      )
      expect(env.scrape.calls).toEqual([])
    }).pipe(
      Effect.provide(
        Adapter.layer({
          ...env.handles,
          scrape: {
            ...env.handles.scrape,
            createBatch: () => Effect.die(cause),
          },
        }),
      ),
    )
  })

  it.effect("keeps a non-duplicate per-id failure as an error", () => {
    const env = setup()
    const cause = rpcDefect("rate limit exceeded")
    return Effect.gen(function* () {
      const executions = yield* Executions
      expect(
        yield* Effect.flip(executions.start("scrape", [request("one")])),
      ).toEqual(
        new ExecutionsError({ operation: "start", kind: "scrape", cause }),
      )
    }).pipe(
      Effect.provide(
        Adapter.layer({
          ...env.handles,
          scrape: {
            ...env.handles.scrape,
            createBatch: () => Effect.die(duplicate),
            create: () => Effect.die(cause),
          },
        }),
      ),
    )
  })

  it.effect(
    "accepts 100, refuses 101 before calling the binding, and ignores empty batches",
    () => {
      const env = setup()
      return Effect.gen(function* () {
        const executions = yield* Executions
        expect(yield* executions.start("scrape", [])).toEqual({
          started: [],
          skipped: [],
        })
        expect(env.scrape.calls).toEqual([])
        expect(
          yield* Effect.flip(
            executions.start(
              "scrape",
              Array.from({ length: 101 }, (_, i) => request(String(i))),
            ),
          ),
        ).toMatchObject({
          _tag: "ExecutionsError",
          operation: "start",
          kind: "scrape",
        })
        expect(env.scrape.calls).toEqual([])
        expect(
          (yield* executions.start(
            "scrape",
            Array.from({ length: 100 }, (_, i) => request(String(i))),
          )).started,
        ).toHaveLength(100)
        expect(env.scrape.calls).toHaveLength(1)
      }).pipe(Effect.provide(Adapter.layer(env.handles)))
    },
  )

  it.effect("deduplicates input IDs", () => {
    const env = setup()
    return Effect.gen(function* () {
      const executions = yield* Executions
      expect(
        yield* executions.start("scrape", [request("one"), request("one")]),
      ).toEqual({ started: ["one"], skipped: [] })
      expect(env.scrape.calls[0]?.input).toEqual([
        { id: "one", params: { scrapeId: "one", traceparent } },
      ])
    }).pipe(Effect.provide(Adapter.layer(env.handles)))
  })

  it.effect(
    "decodes every domain status, mapping future strings to unknown",
    () => {
      const env = setup()
      return Effect.gen(function* () {
        const executions = yield* Executions
        for (const status of ExecutionStatuses) {
          env.extraction.states.set("id", status)
          expect(yield* executions.status("extraction", "id")).toEqual(
            Option.some(status),
          )
        }
        env.extraction.states.set("id", "new-platform-status")
        expect(yield* executions.status("extraction", "id")).toEqual(
          Option.some("unknown"),
        )
        expect(yield* executions.status("extraction", "absent")).toEqual(
          Option.none(),
        )
      }).pipe(Effect.provide(Adapter.layer(env.handles)))
    },
  )

  it.effect(
    "returns None when the status call itself reports not found",
    () => {
      const env = setup()
      return Effect.gen(function* () {
        const executions = yield* Executions
        expect(yield* executions.status("scrape", "one")).toEqual(Option.none())
      }).pipe(
        Effect.provide(
          Adapter.layer({
            ...env.handles,
            scrape: {
              ...env.handles.scrape,
              get: (id) =>
                Effect.succeed({
                  id,
                  status: () => Effect.die(missing),
                  terminate: () => Effect.void,
                }),
            },
          }),
        ),
      )
    },
  )

  it.effect("terminates a live instance and ignores missing instances", () => {
    const env = setup()
    env.extraction.states.set("id", "running")
    return Effect.gen(function* () {
      const executions = yield* Executions
      yield* executions.terminate("extraction", "id")
      expect(env.extraction.states.get("id")).toBe("terminated")
      yield* executions.terminate("extraction", "absent")
    }).pipe(Effect.provide(Adapter.layer(env.handles)))
  })

  for (const message of [
    "instance.not_found",
    "(instance.cannot_terminate) Cannot terminate instance since its on a finite state",
    "Instance is already terminated",
  ]) {
    it.effect(`swallows terminal/missing terminate defect: ${message}`, () => {
      const env = setup()
      return Effect.gen(function* () {
        const executions = yield* Executions
        yield* executions.terminate("scrape", "id")
      }).pipe(
        Effect.provide(
          Adapter.layer({
            ...env.handles,
            scrape: {
              ...env.handles.scrape,
              get: (id) =>
                Effect.succeed({
                  id,
                  status: () => Effect.succeed({ status: "complete" }),
                  terminate: () => Effect.die(rpcDefect(message)),
                }),
            },
          }),
        ),
      )
    })
  }

  for (const operation of ["status", "terminate"] as const) {
    for (const phase of ["get", "instance"] as const) {
      it.effect(`maps unrelated ${phase} defects during ${operation}`, () => {
        const env = setup()
        const cause = rpcDefect("permission denied")
        return Effect.gen(function* () {
          const executions = yield* Executions
          expect(
            yield* Effect.flip(executions[operation]("scrape", "id")),
          ).toEqual(new ExecutionsError({ operation, kind: "scrape", cause }))
        }).pipe(
          Effect.provide(
            Adapter.layer({
              ...env.handles,
              scrape: {
                ...env.handles.scrape,
                get: (id) =>
                  phase === "get"
                    ? Effect.die(cause)
                    : Effect.succeed({
                        id,
                        status: () => Effect.die(cause),
                        terminate: () => Effect.die(cause),
                      }),
              },
            }),
          ),
        )
      })
    }
  }

  it.effect(
    "preserves interruption instead of converting it to a port error",
    () => {
      const env = setup()
      return Effect.gen(function* () {
        const executions = yield* Executions
        const exit = yield* Effect.exit(
          executions.start("scrape", [request("id")]),
        )
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
          true,
        )
      }).pipe(
        Effect.provide(
          Adapter.layer({
            ...env.handles,
            scrape: {
              ...env.handles.scrape,
              createBatch: () => Effect.interrupt,
            },
          }),
        ),
      )
    },
  )

  it.effect("annotates each operation's span with the execution kind", () => {
    const seen: { operation: string; kind: unknown }[] = []
    const observe = (operation: string) =>
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan.pipe(Effect.orDie)
        seen.push({
          operation,
          kind: span.attributes.get("shelf.execution.kind"),
        })
      })
    const handle = <Params>(): Adapter.WorkflowHandle<Params> => ({
      createBatch: (batch) => observe("start").pipe(Effect.as(batch)),
      create: ({ id }) => Effect.succeed({ id }),
      get: (id) =>
        Effect.succeed({
          id,
          status: () =>
            observe("status").pipe(Effect.as({ status: "running" })),
          terminate: () => observe("terminate"),
        }),
    })
    return Effect.gen(function* () {
      const executions = yield* Executions
      for (const kind of ["scrape", "extraction"] satisfies ExecutionKind[]) {
        yield* executions.start(kind, [request("one")])
        yield* executions.status(kind, "one")
        yield* executions.terminate(kind, "one")
      }
      expect(seen).toEqual(
        ["scrape", "extraction"].flatMap((kind) =>
          ["start", "status", "terminate"].map((operation) => ({
            operation,
            kind,
          })),
        ),
      )
    }).pipe(
      Effect.provide(Adapter.layer({ scrape: handle(), extraction: handle() })),
    )
  })
})
