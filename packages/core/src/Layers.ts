import * as Layer from "effect/Layer"
import { Brands } from "./Catalog/Brands.ts"
import type { Db } from "./Sql/Db.ts"
import { Scrapes } from "./Scraping/Scrapes.ts"
import { ScrapeRunner } from "./Scraping/ScrapeRunner.ts"
import { Cron as CronService } from "./Scheduling/Cron.ts"
import { Sweeps } from "./Scheduling/Sweeps.ts"

/**
 * One live layer per entrypoint, each leaving `Db` and the platform tags
 * unresolved so infra provides them per request or Workflow step. A catalog
 * request never builds the scrape providers it does not use. Wiring between
 * services uses `Layer.provide`, never a bare merge; tests compose every
 * entrypoint over the fakes in test/layers/Core.ts.
 */
export const Catalog: Layer.Layer<Brands, never, Db> = Layer.mergeAll(
  Brands.layer,
)

export const Api = Layer.mergeAll(Catalog, Scrapes.layer)
export const Cron = CronService.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Sweeps.layer, Scrapes.layer)),
)
export const ScrapeWorkflow = ScrapeRunner.layer
