import * as Layer from "effect/Layer"
import { Brands } from "./Catalog/Brands.ts"
import type { Db } from "./Sql/Db.ts"

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
