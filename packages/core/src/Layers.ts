import * as Layer from "effect/Layer"
import { Auth } from "./Auth/Auth.ts"
import { EmailSender } from "./Auth/EmailSender.ts"
import { Brands } from "./Catalog/Brands.ts"
import { Cascade } from "./Catalog/Cascade.ts"
import { Listings } from "./Catalog/Listings.ts"
import { Pages } from "./Catalog/Pages.ts"
import { Products } from "./Catalog/Products.ts"
import { Retailers } from "./Catalog/Retailers.ts"
import { Variants } from "./Catalog/Variants.ts"
import { Cron as CronService } from "./Scheduling/Cron.ts"
import { Sweeps } from "./Scheduling/Sweeps.ts"
import { ExtractionRunner } from "./Scraping/ExtractionRunner.ts"
import { Extractions } from "./Scraping/Extractions.ts"
import { ScrapeRunner } from "./Scraping/ScrapeRunner.ts"
import { Scrapes } from "./Scraping/Scrapes.ts"
import type { Db } from "./Sql/Db.ts"
import type { R2Bucket } from "./Storage/R2Bucket.ts"

/**
 * One live layer per entrypoint, each leaving `Db` and the platform tags
 * unresolved so infra provides them per request or Workflow step. A catalog
 * request never builds the scrape providers it does not use. Wiring between
 * services uses `Layer.provide`, never a bare merge; tests compose every
 * entrypoint over the fakes in test/layers/Core.ts.
 * Catalog features share Cascade; database and object storage are supplied per invocation.
 */
export const Catalog: Layer.Layer<
  Brands | Products | Variants | Retailers | Listings | Pages | Cascade,
  never,
  Db | R2Bucket
> = Layer.mergeAll(
  Brands.layer,
  Products.layer,
  Variants.layer,
  Retailers.layer,
  Listings.layer,
  Pages.layer,
).pipe(Layer.provideMerge(Cascade.layer))

export const Api = Layer.mergeAll(
  Catalog,
  Scrapes.layer,
  Extractions.layer,
  Auth.layer,
)
export const Cron = CronService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Sweeps.layer, Scrapes.layer, Extractions.layer),
  ),
)
export const ScrapeWorkflow = ScrapeRunner.layer

/**
 * The live providers, left beside the Workflow layer rather than inside it:
 * `apps/server` resolves the Browser binding and the platform `HttpClient`
 * per invocation and provides them there (#22, ADR 0006), while tests run
 * the same Workflow layer over the scripted fake.
 */
export { layer as ScrapeProvidersLive } from "./Providers/ScrapeProviders.ts"
export { BrowserRendering } from "./Providers/BrowserRendering.ts"

export const ExtractionWorkflow = ExtractionRunner.layer
export { layer as LanguageModelLive } from "./Providers/LanguageModel.ts"

export const EmailSenderLive = EmailSender.layerPostmark
