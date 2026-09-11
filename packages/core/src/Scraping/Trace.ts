import type { SpanId } from "@digital-shelf/domain/Scraping/Execution"
import type { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
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
 */

export const RootTraceId = Context.Reference<Option.Option<string>>(
  "@digital-shelf/core/Scraping/RootTraceId",
  { defaultValue: Option.none },
)

export const withTraceIdentity = (base: Tracer.Tracer): Tracer.Tracer =>
  Tracer.make({
    span(options) {
      const span: Mutable<Tracer.Span> = base.span(options)
      const traceId = Context.get(options.annotations, RootTraceId)

      if (options.root && Option.isSome(traceId)) span.traceId = traceId.value

      return span
    },
    context: base.context,
  })

export const layer = Layer.effect(
  Tracer.Tracer,
  Effect.map(Effect.tracer, withTraceIdentity),
)

export const traceIdOf = (scrapeId: ScrapeId): string =>
  scrapeId.replaceAll("-", "").toLowerCase()

export const traceparentOf = (scrapeId: ScrapeId, rootSpanId: SpanId): string =>
  `00-${traceIdOf(scrapeId)}-${rootSpanId}-01`
