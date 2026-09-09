import * as LanguageModelTest from "./LanguageModel.ts"
import * as Layers from "@digital-shelf/core/Layers"
import * as Layer from "effect/Layer"
import * as DbTest from "./Db.ts"
import * as ExecutionsTest from "./Executions.ts"
import * as R2BucketTest from "./R2Bucket.ts"
import * as ScrapeProvidersTest from "./ScrapeProviders.ts"

/** Every entrypoint layer over one test database and shared scripted fakes. */
export const layerTest = Layer.mergeAll(
  Layers.Catalog,
  Layers.Api,
  Layers.Cron,
  Layers.ScrapeWorkflow,
  Layers.ExtractionWorkflow,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      DbTest.layerTest,
      ExecutionsTest.layerTest,
      R2BucketTest.layerTest,
      ScrapeProvidersTest.layerTest,
      LanguageModelTest.layerTest,
    ),
  ),
)
