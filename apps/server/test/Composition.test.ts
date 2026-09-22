import * as ScrapeProvidersTest from "@app/core/test/layers/ScrapeProviders"
import * as LanguageModelTest from "@app/core/test/layers/LanguageModel"
import {
  WorkflowStep,
  type WorkflowTaskOptions,
} from "alchemy/Cloudflare/Workflows"
import { run as runScrape } from "../src/ScrapeWorkflow"
import { run as runExtraction } from "../src/ExtractionWorkflow"
import { RoutesLayer } from "../src/http"
import { Stage } from "alchemy/Stage"
import { expect, expectTypeOf, it } from "@effect/vitest"
import type { Db } from "@app/db"
import { Cron } from "@app/core/cron"
import type { Executions } from "@app/core/executions"
import type { R2Bucket } from "@app/core/storage/r2-bucket"
import type { ScrapeProviders } from "@app/core/scrapes/providers"
import type { LanguageModel } from "effect/unstable/ai/LanguageModel"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as DbTest from "@app/core/test/layers/Db"
import * as ExecutionsTest from "@app/core/test/layers/Executions"
import * as R2BucketTest from "@app/core/test/layers/R2Bucket"
import * as Composition from "../src/Worker"

it("default application graphs require only their database and platform ports", () => {
  expectTypeOf<
    Layer.Services<typeof Composition.ApplicationLayer>
  >().toEqualTypeOf<Db | Executions.Service | R2Bucket.Service>()
  expectTypeOf<
    Layer.Services<typeof Composition.ScrapeWorkflowLayer>
  >().toEqualTypeOf<
    Db | Executions.Service | R2Bucket.Service | ScrapeProviders.Service
  >()
  expectTypeOf<
    Layer.Services<typeof Composition.ExtractionWorkflowLayer>
  >().toEqualTypeOf<
    Db | Executions.Service | R2Bucket.Service | LanguageModel
  >()
})

it.effect(
  "builds the real default HTTP and cron HttpLayer over one Db construction",
  () =>
    Effect.gen(function* () {
      const count = { databases: 0 }

      const DatabaseLayer = DbTest.TestLayer.pipe(
        Layer.tap(() =>
          Effect.sync(() => {
            count.databases += 1
          }),
        ),
      )

      const AdaptersLayer = Layer.mergeAll(
        DatabaseLayer,
        ExecutionsTest.TestLayer,
        R2BucketTest.TestLayer,
      )

      const ConfigurationLayer = ConfigProvider.layerAdd(
        ConfigProvider.fromUnknown({
          AUTH_SECRET: "local-composition-test-at-least-thirty-two-characters",
          AUTH_BASE_URL: "http://localhost",
          POSTMARK_SERVER_TOKEN: "local-test-never-sent",
          POSTMARK_FROM: "local@example.test",
        }),
      )

      const application = yield* Layer.build(
        Composition.ApplicationLayer.pipe(
          Layer.provideMerge(AdaptersLayer),
          Layer.provide(ConfigurationLayer),
        ),
      )

      const cron = Context.get(application, Cron.Service)
      const report = yield* cron.tick()
      expect(report.phases.map((phase) => phase.outcome)).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ])

      const HttpLayer = RoutesLayer.pipe(
        Layer.provide(Layer.succeed(Stage, "dev")),
      ).pipe(Layer.provide(Layer.succeedContext(application)))

      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(HttpLayer, { disableLogger: true }),
        ),
        (server) => Effect.promise(() => server.dispose()),
      )

      expect(
        (yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/v1/ping")),
        )).status,
      ).toBe(200)

      const health = yield* Effect.promise(() =>
        app.handler(new Request("http://localhost/health")),
      )

      expect(health.status).toBe(200)
      expect(yield* Effect.promise(() => health.json())).toEqual({
        ok: true,
        stage: "dev",
        db: "ok",
      })
      expect(
        (yield* Effect.promise(() =>
          app.handler(new Request("http://localhost/api/v1/brands")),
        )).status,
      ).toBe(401)
      expect(count.databases).toBe(1)
    }).pipe(Effect.scoped),
  60_000,
)

it.effect(
  "independent real Workflow steps build and close their own database contexts",
  () =>
    Effect.gen(function* () {
      const lifetime = { opened: 0, closed: 0 }

      const DatabaseLayer = DbTest.TestLayer.pipe(
        Layer.tap(() =>
          Effect.gen(function* () {
            expect(lifetime.opened).toBe(lifetime.closed)
            lifetime.opened += 1
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                lifetime.closed += 1
              }),
            )
          }),
        ),
      )

      const PortsLayer = Layer.mergeAll(
        DatabaseLayer,
        ExecutionsTest.TestLayer,
        R2BucketTest.TestLayer,
        ScrapeProvidersTest.TestLayer,
        LanguageModelTest.TestLayer,
      )

      const ScrapeLayer = Composition.ScrapeWorkflowLayer.pipe(
        Layer.provide(PortsLayer),
      )

      const ExtractionLayer = Composition.ExtractionWorkflowLayer.pipe(
        Layer.provide(PortsLayer),
      )

      const steps = WorkflowStep.of({
        do: <T>(task: WorkflowTaskOptions<T, never, never>): Effect.Effect<T> =>
          task.effect,
        sleep: () => Effect.void,
        sleepUntil: () => Effect.void,
        waitForEvent: () =>
          Effect.die("Unexpected wait in claim-only Workflow"),
      })

      const id = "00000000-0000-4000-8000-000000000404"

      const traceparent =
        "00-00000000000040008000000000000404-0123456789abcdef-01"

      for (const invocation of [1, 2]) {
        // Scrape rejects its missing-row transition at claim; Extraction also
        // attempts compensation. Every real step must release its own context.
        yield* runScrape({ scrapeId: id, traceparent }, ScrapeLayer).pipe(
          Effect.provideService(WorkflowStep, steps),
        )
        expect(lifetime).toEqual({
          opened: invocation * 3 - 2,
          closed: invocation * 3 - 2,
        })

        const result = yield* runExtraction(
          { extractionId: id, traceparent },
          ExtractionLayer,
        ).pipe(Effect.provideService(WorkflowStep, steps), Effect.exit)

        expect(Exit.isFailure(result)).toBe(true)
        expect(lifetime).toEqual({
          opened: invocation * 3,
          closed: invocation * 3,
        })
      }
    }).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ AI_GATEWAY_ID: "offline-workflow" }),
      ),
    ),
  60_000,
)
