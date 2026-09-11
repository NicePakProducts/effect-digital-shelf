import { ExtractionRunner } from "@digital-shelf/core/Scraping/ExtractionRunner"
import { Extractions } from "@digital-shelf/core/Scraping/Extractions"
import { ScrapeRunner } from "@digital-shelf/core/Scraping/ScrapeRunner"
import { Scrapes } from "@digital-shelf/core/Scraping/Scrapes"
import { Transitions } from "@digital-shelf/core/Scraping/Transitions"
import { ExtractionsRepo } from "@digital-shelf/core/Scraping/repositories/ExtractionsRepo"
import { ParentsRepo } from "@digital-shelf/core/Scraping/repositories/ParentsRepo"
import { ScrapesRepo } from "@digital-shelf/core/Scraping/repositories/ScrapesRepo"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import type * as Effect from "effect/Effect"

describe("Scraping layers", () => {
  it("feature and transition methods need no services after construction", () => {
    expectTypeOf<
      Effect.Services<
        | ReturnType<Scrapes["Service"][keyof Scrapes["Service"]]>
        | ReturnType<Extractions["Service"][keyof Extractions["Service"]]>
        | ReturnType<ScrapeRunner["Service"][keyof ScrapeRunner["Service"]]>
        | ReturnType<
            ExtractionRunner["Service"][keyof ExtractionRunner["Service"]]
          >
        | ReturnType<Transitions["Service"][keyof Transitions["Service"]]>
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
      const descriptor = Object.getOwnPropertyDescriptor(service, "layer")
      expect(descriptor?.get === undefined).toBe(true)
      expect(descriptor?.value).toBeDefined()
      expect(service.layer).toBe(service.layer)
    }
  })
})
