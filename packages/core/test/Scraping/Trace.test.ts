import * as Trace from "@app/core/scrapes/trace"
import { describe, expect, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"

const traceId = "0123456789abcdef0123456789abcdef"

const annotations = Context.make(Trace.RootTraceId, Option.some(traceId))

class FirstTracer extends Context.Service<FirstTracer, Tracer.Tracer>()(
  "@app/core/test/Scraping/Trace.test/FirstTracer",
) {}

class SecondTracer extends Context.Service<SecondTracer, Tracer.Tracer>()(
  "@app/core/test/Scraping/Trace.test/SecondTracer",
) {}

describe("Scrape trace identity", () => {
  it.effect("overrides an annotated root before children inherit its id", () =>
    Effect.gen(function* () {
      const root = yield* Effect.currentSpan
      expect(root.traceId).toBe(traceId)
      expect(Option.isNone(root.parent)).toBe(true)

      const child = yield* Effect.currentSpan.pipe(Effect.withSpan("child"))
      expect(child.traceId).toBe(traceId)
      expect(Option.getOrThrow(child.parent)).toBe(root)
    }).pipe(
      Effect.withSpan("root", { root: true, annotations }),
      Effect.provide(Trace.layer()),
    ),
  )

  it.effect("preserves an explicit parent's trace even with root: true", () => {
    const parent = Tracer.externalSpan({
      traceId: "fedcba9876543210fedcba9876543210",
      spanId: "0123456789abcdef",
    })

    return Effect.gen(function* () {
      const child = yield* Effect.currentSpan
      expect(Option.getOrThrow(child.parent)).toBe(parent)
      expect(child.traceId).toBe(parent.traceId)
    }).pipe(
      Effect.withSpan("child", { root: true, parent, annotations }),
      Effect.provide(Trace.layer()),
    )
  })

  it.effect("wraps each composition's tracer in a shared layer graph", () => {
    const calls: string[] = []

    const base = (label: string) =>
      Tracer.make({
        span(options) {
          calls.push(`${label}:${options.name}`)

          return new Tracer.NativeSpan(options)
        },
      })

    const FirstTracerLayer = Layer.effect(FirstTracer, Effect.tracer).pipe(
      Layer.provide(Trace.layer()),
      Layer.provide(Layer.succeed(Tracer.Tracer, base("first"))),
    )

    const SecondTracerLayer = Layer.effect(SecondTracer, Effect.tracer).pipe(
      Layer.provide(Trace.layer()),
      Layer.provide(Layer.succeed(Tracer.Tracer, base("second"))),
    )

    return Effect.gen(function* () {
      for (const tracer of [yield* FirstTracer, yield* SecondTracer]) {
        const span = yield* Effect.currentSpan.pipe(
          Effect.withSpan("probe", { root: true, annotations }),
          Effect.withTracer(tracer),
        )

        expect(span.traceId).toBe(traceId)
      }

      expect(calls).toEqual(["first:probe", "second:probe"])
    }).pipe(Effect.provide(Layer.mergeAll(FirstTracerLayer, SecondTracerLayer)))
  })
})
