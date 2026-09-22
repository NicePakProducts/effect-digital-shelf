import type { Execution } from "@app/schema/execution"
import type { ScrapeId } from "@app/schema/ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import type { Mutable } from "effect/Types"
/**
 * Trace identity derives from the Scrape row (ADR 0007): the trace id is the
 * Scrape id without dashes, the root span id is stored on the row, and the
 * pair travels into a Workflow instance's params as a W3C `traceparent`.
 * The wrapper replaces the id minted by the base tracer before OTLP reads it at span end.
 * Each layer() call is fresh so a shared layer memo map cannot reuse another composition's tracer.
 */

export const RootTraceId = Context.Reference<Option.Option<string>>(
  "@app/core/scrapes/trace/RootTraceId",
  { defaultValue: Option.none },
)

export const withTraceIdentity = (base: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span: Mutable<Tracer.Span> = base.span(options)
      const traceId = Context.get(options.annotations, RootTraceId)

      if (Option.isNone(span.parent) && Option.isSome(traceId))
        span.traceId = traceId.value

      return span
    },
    context: base.context,
  })

export const layer = () =>
  Layer.effect(Tracer.Tracer, Effect.map(Effect.tracer, withTraceIdentity))

export const traceIdOf = (scrapeId: ScrapeId): string =>
  scrapeId.replaceAll("-", "").toLowerCase()

export const traceparentOf = (
  scrapeId: ScrapeId,
  rootSpanId: Execution.SpanId,
): string => `00-${traceIdOf(scrapeId)}-${rootSpanId}-01`
