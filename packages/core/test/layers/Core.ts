import * as Layers from "@digital-shelf/core/Layers"
import { Sweeps } from "@digital-shelf/core/Scheduling/Sweeps"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Layer from "effect/Layer"
import * as DbTest from "./Db.ts"
import * as EmailSenderTest from "./EmailSender.ts"
import * as ExecutionsTest from "./Executions.ts"
import * as LanguageModelTest from "./LanguageModel.ts"
import * as R2BucketTest from "./R2Bucket.ts"
import * as ScrapeProvidersTest from "./ScrapeProviders.ts"

/** Every entrypoint layer over one test database and shared scripted fakes. */
export const layerTest = Layer.mergeAll(
  Layers.Catalog,
  Layers.Api,
  Layers.Cron,
  Sweeps.layer,
  Layers.ScrapeWorkflow,
  Layers.ExtractionWorkflow,
).pipe(
  Layer.provideMerge(Layers.TraceIdentity()),
  Layer.provideMerge(
    Layer.mergeAll(
      DbTest.layerTest,
      ExecutionsTest.layerTest,
      R2BucketTest.layerTest,
      ScrapeProvidersTest.layerTest,
      LanguageModelTest.layerTest,
      EmailSenderTest.layerTest,
    ),
  ),
  Layer.provideMerge(
    ConfigProvider.layerAdd(
      ConfigProvider.fromUnknown({
        AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
        AUTH_BASE_URL: "http://localhost",
        AI_GATEWAY_ID: "digital-shelf-ai-gateway-dev",
      }),
    ),
  ),
)
