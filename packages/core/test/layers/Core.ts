import * as Layers from "./Features"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Layer from "effect/Layer"
import * as DbTest from "./Db"
import * as EmailSenderTest from "./EmailSender"
import * as ExecutionsTest from "./Executions"
import * as LanguageModelTest from "./LanguageModel"
import * as R2BucketTest from "./R2Bucket"
import * as ScrapeProvidersTest from "./ScrapeProviders"

/** Every entrypoint layer over one test database and shared scripted fakes. */
export const TestLayer = Layer.mergeAll(
  Layers.CatalogLayer,
  Layers.ApiLayer,
  Layers.CronLayer,
  Layers.ScrapeWorkflowLayer,
  Layers.ExtractionWorkflowLayer,
).pipe(
  Layer.provideMerge(Layers.TraceIdentity()),
  Layer.provideMerge(
    Layer.mergeAll(
      DbTest.TestLayer,
      ExecutionsTest.TestLayer,
      R2BucketTest.TestLayer,
      ScrapeProvidersTest.TestLayer,
      LanguageModelTest.TestLayer,
      EmailSenderTest.TestLayer,
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
