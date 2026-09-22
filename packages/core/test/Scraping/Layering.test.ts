import { ExtractionRunner } from "@app/core/scrapes/extractions/runner"
import { Extractions } from "@app/core/scrapes/extractions"
import { ScrapeRunner } from "@app/core/scrapes/runner"
import { Scrapes } from "@app/core/scrapes"
import { Transitions } from "../../src/scrapes/transitions"
import { ExtractionsRepo } from "../../src/scrapes/extractions/repository"
import { ParentsRepo } from "../../src/scrapes/parents/repository"
import { ScrapesRepo } from "../../src/scrapes/repository"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import type * as Effect from "effect/Effect"

describe("Scraping layers", () => {
  it("feature and transition methods need no services after construction", () => {
    expectTypeOf<
      Effect.Services<
        | ReturnType<Scrapes.Interface[keyof Scrapes.Interface]>
        | ReturnType<Extractions.Interface[keyof Extractions.Interface]>
        | ReturnType<ScrapeRunner.Interface[keyof ScrapeRunner.Interface]>
        | ReturnType<
            ExtractionRunner.Interface[keyof ExtractionRunner.Interface]
          >
        | ReturnType<Transitions.Interface[keyof Transitions.Interface]>
      >
    >().toEqualTypeOf<never>()
  })

  it("every layer is a stable field, never allocated on access", () => {
    for (const service of [
      ScrapesRepo,
      ExtractionsRepo,
      ParentsRepo,
      Transitions,
      Scrapes,
      Extractions,
      ScrapeRunner,
      ExtractionRunner,
    ]) {
      expect(service.layer).toBeDefined()
      expect(service.layer).toBe(service.layer)
    }
  })
})
