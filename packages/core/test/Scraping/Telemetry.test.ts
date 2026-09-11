import * as Option from "effect/Option"
import { Extractions } from "@digital-shelf/core/Scraping/Extractions"
import { ExtractionRunner } from "@digital-shelf/core/Scraping/ExtractionRunner"
import { successfulScrape } from "../fixtures/Scraping.ts"
import { expect, it } from "@effect/vitest"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { ScrapeRunner } from "@digital-shelf/core/Scraping/ScrapeRunner"
import { Cron } from "@digital-shelf/core/Scheduling/Cron"
import * as Effect from "effect/Effect"
import * as Tracer from "effect/Tracer"
import * as CoreTest from "../layers/Core.ts"
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

          yield* Effect.gen(function* () {
            const scrapes = yield* Scrapes
            const runner = yield* ScrapeRunner
            const row = yield* scrapes.trigger({ parent })
            yield* Effect.flip(scrapes.trigger({ parent }))
            yield* scrapes.bulk({ _tag: "Brand", brandId: fixture.brandId })
            yield* runner.claim(row.id)
            yield* runner.claim(row.id)
            yield* runner.fail(row.id, "unknown", "test")
            yield* Effect.flip(runner.claim(row.id))
            yield* (yield* Cron).tick()
          }).pipe(Effect.withTracer(tracer))
          const roots = spans.filter((span) => span.name === "Scrape.created")
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
          ])
            expect(spans.some((span) => span.name === `Cron.${name}`)).toBe(
              true,
            )
          const tick = spans.find((span) => span.name === "Cron.tick")
          expect(tick?.attributes.get("shelf.tick.stuck.failed")).toBe(0)
          expect(tick?.attributes.get("shelf.tick.cadenceDue.created")).toBe(0)
          expect(tick?.attributes.get("shelf.tick.retention.deleted")).toBe(0)
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
            const row = yield* (yield* Extractions).trigger({
              _tag: "Scrape",
              scrapeId: scrape.id,
            })

            const runner = yield* ExtractionRunner
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
            spans
              .filter((span) => span.name === "Extraction.transition")
              .map((span) => span.attributes.get("shelf.transition")),
          ).toEqual(["applied", "already_applied", "applied"])
          const llm = spans.find((span) => span.name === "Extraction.llm")
          expect(llm?.attributes.get("gen_ai.request.model")).toBe(row.model)
          expect(llm?.attributes.get("gen_ai.usage.input_tokens")).toBe(10)
          expect(llm?.attributes.get("gen_ai.usage.output_tokens")).toBe(5)
        }),
    )
  },
)
