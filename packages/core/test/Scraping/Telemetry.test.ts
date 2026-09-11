import { TriggerExtraction } from "@digital-shelf/domain/Scraping/ScrapingManagement"
import { BulkScrape } from "@digital-shelf/domain/Scraping/ScrapingManagement"
import * as Option from "effect/Option"
import { Extractions } from "@digital-shelf/core/Scraping/Extractions"
import { ExtractionRunner } from "@digital-shelf/core/Scraping/ExtractionRunner"
import { extraction, successfulScrape } from "../fixtures/Scraping.ts"
import { expect, it } from "@effect/vitest"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { ScrapeRunner } from "@digital-shelf/core/Scraping/ScrapeRunner"
import { Cron } from "@digital-shelf/core/Scheduling/Cron"
import { traceIdOf } from "@digital-shelf/core/Scraping/Trace"
import { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Tracer from "effect/Tracer"
import * as TestClock from "effect/testing/TestClock"
import * as CoreTest from "../layers/Core.ts"
import { ExecutionsTest } from "../layers/Executions.ts"
import { reset, seed } from "../fixtures/Scraping.ts"

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "Lifecycle telemetry",
  (it) => {
    it.effect(
      "creation, transition and tick spans use the ADR vocabulary",
      () =>
        Effect.gen(function* () {
          yield* reset
          const fixture = yield* seed()
          const { parent } = yield* fixture.listing
          const base = yield* Tracer.Tracer
          const spans: Tracer.Span[] = []

          const tracer = Tracer.make({
            span(options) {
              const span = base.span(options)
              spans.push(span)

              return span
            },
          })

          const row = yield* Effect.gen(function* () {
            const scrapes = yield* Scrapes
            const runner = yield* ScrapeRunner

            const row = yield* scrapes
              .trigger({ parent })
              .pipe(Effect.withSpan("unsampled-caller", { level: "Debug" }))

            yield* Effect.flip(scrapes.trigger({ parent }))
            yield* scrapes.bulk(
              BulkScrape.members[0].make({ brandId: fixture.brandId }),
            )
            yield* runner.claim(row.id)
            yield* runner.claim(row.id)
            yield* runner.fail(row.id, "unknown", "test")
            yield* Effect.flip(runner.claim(row.id))
            yield* (yield* Cron).tick()

            return row
          }).pipe(
            Effect.withTracer(tracer),
            Effect.provideService(Tracer.MinimumTraceLevel, "Info"),
          )

          const roots = spans.filter((span) => span.name === "Scrape.created")

          for (const root of roots) {
            const id = Schema.decodeUnknownSync(ScrapeId)(
              root.attributes.get("shelf.scrape.id"),
            )

            expect(root.traceId).toBe(traceIdOf(id))
            expect(Option.isNone(root.parent)).toBe(true)
            expect(root.sampled).toBe(true)
          }

          const dispatches = spans.filter(
            (span) => span.name === "Scrape.dispatch",
          )

          expect(dispatches).toHaveLength(1)
          const dispatch = dispatches[0]!
          expect(dispatch.sampled).toBe(true)
          expect(dispatch.traceId).toBe(traceIdOf(row.id))
          expect(Option.getOrThrow(dispatch.parent)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "ExternalSpan",
            spanId: row.rootSpanId,
            traceId: traceIdOf(row.id),
          })
          expect(dispatch.links[0]?.span).toBe(
            spans.find((span) => span.name === "Scrapes.trigger"),
          )
          expect(dispatch.links[0]?.span.sampled).toBe(false)
          expect(dispatch.attributes.get("shelf.scrape.id")).toBe(row.id)
          expect(dispatch.attributes.get("shelf.execution.kind")).toBe("scrape")
          expect(dispatch.attributes.get("shelf.dispatch.started")).toBe(true)
          expect(
            new Set(roots.map((span) => span.attributes.get("shelf.scrape.id")))
              .size,
          ).toBe(roots.length)
          expect(roots[0]?.attributes.get("shelf.parent.kind")).toBe("listing")
          expect(roots[0]?.attributes.get("shelf.parent.id")).toBe(
            parent.listingId,
          )
          expect(roots[0]?.attributes.get("shelf.retailer.id")).toBe(
            fixture.retailerId,
          )
          expect(roots[0]?.attributes.get("shelf.dispatch.outcome")).toBe(
            "created",
          )
          expect(
            roots.some(
              (span) =>
                span.attributes.get("shelf.dispatch.outcome") ===
                "in-flight-skip",
            ),
          ).toBe(true)

          const transitions = spans.filter(
            (span) => span.name === "Scrape.transition",
          )

          expect(
            transitions.map((span) => span.attributes.get("shelf.transition")),
          ).toEqual(["applied", "already_applied", "applied", "rejected"])
          expect(transitions[0]?.attributes.get("shelf.transition.from")).toBe(
            "pending",
          )
          expect(transitions[0]?.attributes.get("shelf.transition.to")).toBe(
            "running",
          )

          for (const name of [
            "stuck",
            "extractionDrain",
            "scrapeDrain",
            "cadenceDue",
            "retention",
          ]) {
            const phase = spans.find((span) => span.name === `Cron.${name}`)
            expect(phase).toBeDefined()
            expect(phase?.sampled).toBe(true)
          }

          const repositories = spans.filter((span) =>
            span.name.startsWith("ScrapesRepo."),
          )

          expect(repositories.length).toBeGreaterThan(0)
          expect(repositories.every((span) => !span.sampled)).toBe(true)
          const tick = spans.find((span) => span.name === "Cron.tick")
          expect(tick?.sampled).toBe(true)
          expect(tick?.attributes.get("shelf.tick.stuck.failed")).toBe(0)
          expect(tick?.attributes.get("shelf.tick.cadenceDue.created")).toBe(0)
          expect(tick?.attributes.get("shelf.tick.retention.deleted")).toBe(0)
        }),
    )
    it.effect(
      "stuck and reconcile transitions stay in the tick trace and link the affected Scrape roots",
      () =>
        Effect.gen(function* () {
          yield* reset
          const fixture = yield* seed({ paused: true })
          const scrapes = yield* Scrapes

          const running = yield* scrapes.trigger({
            parent: (yield* fixture.listing).parent,
          })

          yield* (yield* ScrapeRunner).claim(running.id)

          const pending = yield* scrapes.trigger({
            parent: (yield* fixture.listing).parent,
          })

          yield* (yield* ExecutionsTest).setStatus(
            "scrape",
            pending.id,
            "errored",
          )

          const extractedScrape = yield* successfulScrape(
            (yield* fixture.listing).parent,
          )

          const extracting = yield* extraction(extractedScrape.id, 1, "running")
          yield* TestClock.adjust("6 minutes")

          const base = yield* Effect.tracer
          const spans: Tracer.Span[] = []

          const tracer = Tracer.make({
            span(options) {
              const span = base.span(options)
              spans.push(span)

              return span
            },
            context: base.context,
          })

          yield* (yield* Cron).tick().pipe(Effect.withTracer(tracer))

          const tick = spans.find((span) => span.name === "Cron.tick")!

          const transitions = spans.filter(
            (span) => span.name === "Scrape.transition",
          )

          expect(transitions).toHaveLength(2)

          for (const row of [running, pending]) {
            const transition = transitions.find(
              (span) => span.attributes.get("shelf.scrape.id") === row.id,
            )!

            expect(transition.traceId).toBe(tick.traceId)
            expect(transition.attributes.get("shelf.transition")).toBe(
              "applied",
            )
            expect(
              transition.links.some(
                (link) =>
                  link.span.spanId === row.rootSpanId &&
                  link.span.traceId === traceIdOf(row.id),
              ),
            ).toBe(true)
            expect((yield* scrapes.get(row.id)).status).toBe("failed")
          }

          const dispatches = spans.filter(
            (span) => span.name === "Scrape.dispatch",
          )

          expect(dispatches).toHaveLength(1)
          expect(dispatches[0]?.attributes.get("shelf.scrape.id")).toBe(
            pending.id,
          )
          expect(dispatches[0]?.attributes.get("shelf.dispatch.started")).toBe(
            false,
          )
          expect(dispatches[0]?.links[0]?.span).toBe(
            spans.find((span) => span.name === "Scrapes.drainPending"),
          )

          const extractionTransition = spans.find(
            (span) => span.name === "Extraction.transition",
          )!

          expect(extractionTransition.traceId).toBe(tick.traceId)
          expect(extractionTransition.attributes.get("shelf.scrape.id")).toBe(
            extractedScrape.id,
          )
          expect(
            extractionTransition.attributes.get("shelf.extraction.id"),
          ).toBe(extracting.id)
          expect(extractionTransition.attributes.get("shelf.attempt")).toBe(1)
          expect((yield* (yield* Extractions).get(extracting.id)).status).toBe(
            "failed",
          )
          expect(
            yield* (yield* ExecutionsTest).service.status(
              "extraction",
              extracting.id,
            ),
          ).toEqual(Option.some("terminated"))
          expect(
            extractionTransition.links.some(
              (link) =>
                link.span.spanId === extractedScrape.rootSpanId &&
                link.span.traceId === traceIdOf(extractedScrape.id),
            ),
          ).toBe(true)
          expect(tick.attributes.get("shelf.tick.stuck.failed")).toBe(1)
          expect(
            tick.attributes.get("shelf.tick.stuck.extractionsFailed"),
          ).toBe(1)
          expect(
            tick.attributes.get("shelf.tick.scrapeDrain.recoveredFailed"),
          ).toBe(1)
        }),
    )

    it.effect(
      "Scrape creation dies when the active tracer has no identity wrapper",
      () =>
        Effect.gen(function* () {
          yield* reset
          const { parent } = yield* (yield* seed()).listing

          const plain = Tracer.make({
            span: (options) => new Tracer.NativeSpan(options),
          })

          const result = yield* (yield* Scrapes)
            .trigger({ parent })
            .pipe(Effect.withTracer(plain), Effect.exit)

          expect(Exit.isFailure(result)).toBe(true)

          if (Exit.isFailure(result)) {
            expect(result.cause.reasons.some(Cause.isDieReason)).toBe(true)
            expect(Cause.pretty(result.cause)).toContain(
              "Scrape.created span does not carry the Scrape trace id; provide TraceIdentity.layer (core Scraping/Trace.ts) above the tracer",
            )
          }

          expect(
            (yield* (yield* Scrapes).list({
              listingId: parent.listingId,
              limit: 10,
            })).items,
          ).toEqual([])
        }),
    )
    it.effect(
      "Extraction creation and LLM spans use the saved Scrape identity and token vocabulary",
      () =>
        Effect.gen(function* () {
          yield* reset

          const scrape = yield* successfulScrape(
            (yield* (yield* seed()).listing).parent,
          )

          const base = yield* Tracer.Tracer
          const spans: Tracer.Span[] = []

          const tracer = Tracer.make({
            span(options) {
              const span = base.span(options)
              spans.push(span)

              return span
            },
          })

          const row = yield* Effect.gen(function* () {
            const row = yield* (yield* Extractions).trigger(
              TriggerExtraction.members[0].make({
                scrapeId: scrape.id,
              }),
            )

            const runner = yield* ExtractionRunner
            expect(yield* (yield* Extractions).redispatch(row.id)).toBe(
              "already-active",
            )
            const target = yield* runner.claim(row.id)
            yield* runner.claim(row.id)
            yield* runner.finish(row.id, yield* runner.extract(row.id, target))

            return row
          }).pipe(Effect.withTracer(tracer))

          const created = spans.find(
            (span) => span.name === "Extraction.created",
          )

          expect(created?.attributes.get("shelf.extraction.id")).toBe(row.id)
          expect(created?.attributes.get("shelf.scrape.id")).toBe(scrape.id)
          expect(created?.attributes.get("shelf.attempt")).toBe(1)
          expect(created?.attributes.get("shelf.trigger")).toBe("manual")
          expect(created?.traceId).toBe(scrape.id.replaceAll("-", ""))
          expect(Option.getOrUndefined(created!.parent)?.spanId).toBe(
            scrape.rootSpanId,
          )

          const dispatches = spans.filter(
            (span) => span.name === "Extraction.dispatch",
          )

          expect(dispatches).toHaveLength(2)
          const dispatch = dispatches[0]!
          expect(dispatch.traceId).toBe(traceIdOf(scrape.id))
          expect(Option.getOrThrow(dispatch.parent)).toMatchObject({
            // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- Partial assertion pattern, not a constructed domain value.
            _tag: "ExternalSpan",
            spanId: scrape.rootSpanId,
            traceId: traceIdOf(scrape.id),
          })
          expect(dispatch.links[0]?.span).toBe(
            spans.find((span) => span.name === "Extractions.trigger"),
          )
          expect(dispatch.attributes.get("shelf.scrape.id")).toBe(scrape.id)
          expect(dispatch.attributes.get("shelf.extraction.id")).toBe(row.id)
          expect(dispatch.attributes.get("shelf.attempt")).toBe(1)
          expect(dispatch.attributes.get("shelf.execution.kind")).toBe(
            "extraction",
          )
          expect(dispatch.attributes.get("shelf.dispatch.started")).toBe(true)
          expect(dispatches[1]?.attributes.get("shelf.dispatch.started")).toBe(
            false,
          )
          expect(dispatches[1]?.links[0]?.span).toBe(
            spans.find((span) => span.name === "Extractions.redispatch"),
          )

          for (const name of [
            "ExtractionRunner.claim",
            "ExtractionRunner.extract",
            "ExtractionRunner.finish",
          ]) {
            const step = spans.find((span) => span.name === name)
            expect(step?.traceId).toBe(scrape.id.replaceAll("-", ""))
            expect(Option.getOrUndefined(step!.parent)?.spanId).toBe(
              scrape.rootSpanId,
            )
            expect(step?.attributes.get("shelf.extraction.id")).toBe(row.id)
            expect(step?.attributes.get("shelf.scrape.id")).toBe(scrape.id)
          }

          expect(
            spans.flatMap((span) =>
              span.name === "Extraction.transition"
                ? [span.attributes.get("shelf.transition")]
                : [],
            ),
          ).toEqual(["applied", "already_applied", "applied"])
          const llm = spans.find((span) => span.name === "Extraction.llm")
          expect(llm?.attributes.get("gen_ai.request.model")).toBe(row.model)
          expect(llm?.attributes.get("gen_ai.usage.input_tokens")).toBe(10)
          expect(llm?.attributes.get("gen_ai.usage.output_tokens")).toBe(5)
        }),
    )
  },
)
