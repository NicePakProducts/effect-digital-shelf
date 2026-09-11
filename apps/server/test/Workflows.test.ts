import { describe, expect, it } from "@effect/vitest"
import {
  ScrapeRunner,
  type FetchTarget,
  FetchOutcome,
} from "@digital-shelf/core/Scraping/ScrapeRunner"
import {
  ExtractionRunner,
  type ExtractTarget,
  ExtractOutcome,
} from "@digital-shelf/core/Scraping/ExtractionRunner"
import { TransitionRejected } from "@digital-shelf/core/Scraping/Transitions"
import {
  ExtractionId,
  RetailerId,
  ScrapeId,
} from "@digital-shelf/domain/Shared/Ids"
import {
  WorkflowStep,
  type WorkflowStepConfig,
  type WorkflowTaskOptions,
} from "alchemy/Cloudflare/Workflows"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { run as scrape } from "../src/ScrapeWorkflow.ts"
import { run as extraction } from "../src/ExtractionWorkflow.ts"
import { databaseStep } from "../src/WorkflowSupport.ts"

const id = Schema.decodeUnknownSync(ScrapeId)(
  "00000000-0000-4000-8000-000000000001",
)

const extractionId = Schema.decodeUnknownSync(ExtractionId)(
  "00000000-0000-4000-8000-000000000002",
)

const rootSpanId = "0123456789abcdef"

const traceId = id.replaceAll("-", "")

const traceparent = `00-${traceId}-${rootSpanId}-01`

const fetchTarget: FetchTarget = {
  url: "https://example.com",
  mode: "basic",
  country: null,
  retailerId: Schema.decodeUnknownSync(RetailerId)(
    "00000000-0000-4000-8000-000000000003",
  ),
  prompt: "Extract",
  rootSpanId,
}

const fetchOutcome = FetchOutcome.members[0].make({
  htmlKey: "html/key",
  rawKey: "raw/key",
  truncated: false,
  envelope: {
    finalUrl: "https://example.com",
    statusCode: 200,
    responseHeaders: {},
    cookies: [],
    innerText: "Example",
    userAgent: "test",
    ipInfo: null,
    type: "browser",
    session: null,
    raw: {},
    attempts: 1,
  },
})

const extractTarget: ExtractTarget = {
  scrapeId: id,
  htmlKey: "html/key",
  prompt: "Extract",
  promptKind: "listing",
  model: "test",
  rootSpanId,
}

const extractOutcome = ExtractOutcome.members[0].make({
  data: { price: 1 },
  finishReason: "stop",
  usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
})

const setup = (
  options: { reject?: string; crash?: string; noExtraction?: boolean } = {},
) => {
  const checkpoint = new Map<string, unknown>()

  const called: string[] = [],
    opened: number[] = [],
    closed: number[] = []

  const spans: { traceId: string; parent: string | undefined }[] = []

  const configs: Record<
    string,
    {
      timeout: WorkflowStepConfig["timeout"]
      retries: WorkflowStepConfig["retries"]
    }
  > = {}

  let active = 0

  const observe = (name: string) =>
    Effect.gen(function* () {
      expect(active).toBe(1)
      called.push(name)
      const span = yield* Effect.currentSpan.pipe(Effect.orDie)
      spans.push({
        traceId: span.traceId,
        parent: Option.getOrUndefined(span.parent)?.spanId,
      })

      if (options.reject === name)
        return yield* new TransitionRejected({
          kind: name.startsWith("scrape") ? "scrape" : "extraction",
          id,
          from: "pending",
          to: "running",
          observed: "failed",
        })

      if (options.crash === name)
        return yield* Effect.die(new Error("platform unavailable"))
    })

  const scrapeRunner = ScrapeRunner.of({
    claim: () => observe("scrape.claim").pipe(Effect.as(fetchTarget)),
    fetch: (scrapeId, target) => {
      expect(scrapeId).toBe(id)
      expect(target).toEqual(fetchTarget)

      return observe("scrape.fetch").pipe(Effect.orDie, Effect.as(fetchOutcome))
    },
    finish: (scrapeId, outcome) => {
      expect(scrapeId).toBe(id)
      expect(outcome).toEqual(fetchOutcome)

      return observe("scrape.finish").pipe(
        Effect.as({ extractionId: options.noExtraction ? null : extractionId }),
      )
    },
    startExtraction: (eid, sid) => {
      expect(eid).toBe(extractionId)
      expect(sid).toBe(id)

      return observe("scrape.startExtraction").pipe(Effect.orDie)
    },
    fail: (sid, code, message) => {
      expect(sid).toBe(id)
      expect(code).toBe("unknown")
      expect(message).toContain("Workflow")

      return observe("scrape.fail")
    },
  })

  const extractionRunner = ExtractionRunner.of({
    claim: () => observe("extraction.claim").pipe(Effect.as(extractTarget)),
    extract: (eid, target) => {
      expect(eid).toBe(extractionId)
      expect(target).toEqual(extractTarget)

      return observe("extraction.extract").pipe(
        Effect.orDie,
        Effect.as(extractOutcome),
      )
    },
    finish: (eid, outcome) => {
      expect(eid).toBe(extractionId)
      expect(outcome).toEqual(extractOutcome)

      return observe("extraction.finish")
    },
    fail: (eid, code) => {
      expect(eid).toBe(extractionId)
      expect(code).toBe("unknown")

      return observe("extraction.fail")
    },
  })

  const scoped = <A>(value: A) =>
    Effect.gen(function* () {
      expect(active).toBe(0)
      active++
      const index = opened.length
      opened.push(index)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          active--
          closed.push(index)
        }),
      )

      return value
    })

  const layers = {
    scrape: Layer.effect(ScrapeRunner, scoped(scrapeRunner)),
    extraction: Layer.effect(ExtractionRunner, scoped(extractionRunner)),
  }

  const steps = WorkflowStep.of({
    do: <T>(task: WorkflowTaskOptions<T, never, never>): Effect.Effect<T> =>
      Effect.suspend(() => {
        configs[task.name] = { timeout: task.timeout, retries: task.retries }

        // Checkpoints cross a JSON boundary; exceptions lose their tagged identity.
        if (checkpoint.has(task.name))
          // SAFETY: Each name replays only its own task's previously saved T.
          return Effect.succeed(checkpoint.get(task.name) as T)

        return task.effect.pipe(
          Effect.map((value) => {
            expect(active).toBe(0)
            const saved: T = JSON.parse(JSON.stringify(value))
            checkpoint.set(task.name, saved)

            return saved
          }),
          Effect.catchCause((cause) =>
            Effect.die(new Error(Cause.pretty(cause))),
          ),
        )
      }),
    sleep: () => Effect.void,
    sleepUntil: () => Effect.void,
    waitForEvent: () => Effect.die("not used"),
  })

  return {
    called,
    opened,
    closed,
    spans,
    configs,
    checkpoint,
    layers,
    run: (kind: "scrape" | "extraction", parent = traceparent) =>
      (kind === "scrape"
        ? scrape({ scrapeId: id, traceparent: parent }, layers.scrape)
        : extraction({ extractionId, traceparent: parent }, layers.extraction)
      ).pipe(Effect.provideService(WorkflowStep, steps)),
  }
}

for (const kind of ["scrape", "extraction"] as const)
  describe(`${kind} composition`, () => {
    const names =
      kind === "scrape"
        ? ["claim", "fetch", "finish", "startExtraction"]
        : ["claim", "extract", "finish"]

    it.effect(
      "checkpoints each result, closes every step scope, and parents every step on the supplied trace",
      () => {
        const env = setup()

        return Effect.gen(function* () {
          yield* env.run(kind)
          expect(env.called).toEqual(names.map((name) => `${kind}.${name}`))
          expect(env.closed).toEqual(env.opened)
          expect(env.opened).toHaveLength(names.length)

          for (const span of env.spans)
            expect(span).toEqual({ traceId, parent: rootSpanId })
          expect(env.configs.claim).toEqual(databaseStep)
          expect(env.configs.finish).toEqual(databaseStep)
          expect(env.configs[kind === "scrape" ? "fetch" : "extract"]).toEqual({
            timeout: kind === "scrape" ? "4 minutes" : "3 minutes",
            retries: { limit: 0, delay: "1 second" },
          })
          yield* env.run(kind)
          expect(env.called).toHaveLength(names.length)
          expect(env.opened).toHaveLength(names.length)
        })
      },
    )

    for (const name of ["claim", "finish"])
      it.effect(
        `stops on rejected ${name}, including checkpoint replay, without fail`,
        () => {
          const env = setup({ reject: `${kind}.${name}` })

          return Effect.gen(function* () {
            yield* env.run(kind)
            const before = [...env.called]
            yield* env.run(kind)
            expect(env.called).toEqual(before)
            expect(env.called.at(-1)).toBe(`${kind}.${name}`)
            expect(env.called).not.toContain(`${kind}.fail`)
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- The persisted stop envelope has no exported constructor; assert its serialized shape.
            expect(env.checkpoint.get(name)).toEqual({ _tag: "stopped" })
            expect(env.closed).toEqual(env.opened)
          })
        },
      )
    it.effect(
      "compensates an unexpected step defect and preserves a failed execution",
      () => {
        const env = setup({
          crash: `${kind}.${kind === "scrape" ? "fetch" : "extract"}`,
        })

        return Effect.gen(function* () {
          const exit = yield* Effect.exit(env.run(kind))
          expect(Exit.isFailure(exit)).toBe(true)
          expect(env.called.at(-1)).toBe(`${kind}.fail`)
          expect(env.configs.fail).toEqual(databaseStep)
          expect(env.closed).toEqual(env.opened)
        })
      },
    )
    it.effect(
      "rejects malformed trace context before any runner is built",
      () => {
        const env = setup()

        return Effect.gen(function* () {
          expect(
            Exit.isFailure(yield* Effect.exit(env.run(kind, "invalid"))),
          ).toBe(true)
          expect(env.opened).toEqual([])
        })
      },
    )
  })

it.effect("does not dispatch an Extraction when finish returns null", () => {
  const env = setup({ noExtraction: true })

  return env.run("scrape").pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        expect(env.called).toEqual([
          "scrape.claim",
          "scrape.fetch",
          "scrape.finish",
        ])
      }),
    ),
  )
})
