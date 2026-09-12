import * as Core from "@digital-shelf/core/Layers"
import { Cron } from "@digital-shelf/core/Scheduling/Cron"
import type { Executions } from "@digital-shelf/core/Scheduling/Executions"
import * as DbAdapter from "@digital-shelf/infra/Adapters/Db"
import * as ExecutionsAdapter from "@digital-shelf/infra/Adapters/Executions"
import * as R2BucketAdapter from "@digital-shelf/infra/Adapters/R2Bucket"
import * as TelemetryAdapter from "@digital-shelf/infra/Adapters/Telemetry"
import {
  resourceName,
  stageOf,
  type Stage,
} from "@digital-shelf/infra/Resources/Names"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Stack } from "alchemy/Stack"
import { Telemetry } from "alchemy"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as ConfigKeys from "./ConfigKeys.ts"
import { ExtractionWorkflow } from "./ExtractionWorkflow.ts"
import * as Http from "./Http.ts"
import { ScrapeWorkflow } from "./ScrapeWorkflow.ts"
import { WorkflowLayers } from "./WorkflowLayers.ts"

/**
 * API paths reach the Worker first; every other path is answered by the
 * asset layer, which serves index.html for client-side routes on navigation
 * requests and only then falls through to the Worker.
 */
const assetsConfig = (directory: string): Cloudflare.Workers.AssetsProps => ({
  directory,
  notFoundHandling: "single-page-application",
  runWorkerFirst: ["/api/*", "/health"],
})

export const makeServer = (options: {
  readonly stage: Stage
  readonly hostname: Option.Option<string>
  /** Built web app directory; the same Worker serves it beside the API. */
  readonly assets: Option.Option<string>
  readonly hyperdrive: Cloudflare.Hyperdrive.Connection
  readonly bucket: Cloudflare.R2.Bucket
}) =>
  Cloudflare.Worker(
    "Server",
    {
      name: resourceName(options.stage, "server"),
      main: import.meta.url,
      compatibility: { date: "2026-09-01", flags: ["nodejs_compat"] },
      workersDev: true,
      assets: Option.getOrUndefined(Option.map(options.assets, assetsConfig)),
      domain: Option.match(options.hostname, {
        onNone: () => null,
        onSome: (name) => ({ name, zoneName: "npbrands.au" }),
      }),
      observability: { enabled: false },
      // The database and its Hyperdrive pool sit in AWS us-east-1, so the Worker
      // runs there too: a request pays one long hop instead of one per query.
      // Pinned rather than Smart Placement, which needs traffic dev never has.
      placement: { region: "aws:us-east-1" },
    },
    Effect.gen(function* () {
      yield* ConfigKeys.bind

      const axiom = Option.all({
        domain: yield* Config.option(Config.string("AXIOM_DOMAIN")),
        token: yield* Config.option(Config.redacted("AXIOM_TOKEN")),
      })

      const versionMetadata = yield* Cloudflare.Workers.VersionMetadata()

      if (Option.isNone(axiom))
        yield* Effect.logWarning(
          "Axiom telemetry disabled: AXIOM_DOMAIN or AXIOM_TOKEN unset",
        )

      // Alchemy builds the registered layer into every event's scope and closes
      // that scope through ctx.waitUntil, so the flush never delays a response.
      yield* Layer.build(
        Telemetry.layer(
          Option.match(axiom, {
            onNone: () => TelemetryAdapter.layerDisabled(options.stage),
            onSome: ({ domain, token }) =>
              Layer.unwrap(
                Effect.map(versionMetadata, ({ id }) =>
                  TelemetryAdapter.layer({
                    axiomToken: token,
                    axiomDomain: domain,
                    stage: options.stage,
                    versionId: id,
                  }),
                ),
              ),
          }),
        ),
      )

      const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(
        options.hyperdrive,
      )

      const bucket = yield* Cloudflare.R2.ReadWriteBucket(options.bucket)
      const browser = yield* Cloudflare.Browser("BROWSER")

      // Both classes register before any layer is built. Deferral lets every
      // invocation use the yielded handles without recursive Workflow init.
      const executions: Layer.Layer<Executions> = Layer.unwrap(
        Effect.sync(() => ExecutionsAdapter.layer({ scrape, extraction })),
      )

      // Built once per isolate; the database connection is memoised per event.
      const adapters = Layer.mergeAll(
        DbAdapter.layer(hyperdrive.connectionString),
        R2BucketAdapter.layer(bucket),
        executions,
      )

      const providers = Core.ScrapeProvidersLive.pipe(
        Layer.provide([
          Layer.unwrap(
            Effect.map(browser.raw, (raw) =>
              Layer.succeed(Core.BrowserRendering, raw),
            ),
          ),
          FetchHttpClient.layer,
        ]),
      )

      const workflowLayers: WorkflowLayers["Service"] = {
        scrape: Core.ScrapeWorkflow.pipe(Layer.provide([adapters, providers])),
        extraction: Core.ExtractionWorkflow.pipe(
          Layer.provide([adapters, Core.LanguageModelLive]),
        ),
      }

      const scrape = yield* ScrapeWorkflow.pipe(
        Effect.provideService(WorkflowLayers, workflowLayers),
      )

      const extraction = yield* ExtractionWorkflow.pipe(
        Effect.provideService(WorkflowLayers, workflowLayers),
      )

      // SAFETY: a construction failure here is a misconfigured deployment (a
      // ConfigError from a core layer); nothing can be served, so it fails the
      // Worker's init once, where Alchemy logs it. Layers open no connection:
      // the Db memoises its pool per event and Better Auth is instantiated on
      // first use.
      const cron = yield* Layer.build(
        Core.Cron.pipe(Layer.provide(adapters)),
      ).pipe(
        Effect.map((context) => Context.get(context, Cron)),
        Effect.orDie,
      )

      yield* Cloudflare.Workers.cron("* * * * *", () =>
        Effect.gen(function* () {
          const report = yield* cron.tick()
          yield* Effect.logInfo(JSON.stringify(report))
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("Cron invocation failed", cause),
          ),
        ),
      )

      const appLayer = Http.layer(options.stage).pipe(
        Layer.provide(Core.Api.pipe(Layer.provide(Core.EmailSenderLive))),
        Layer.provide(adapters),
      )

      // SAFETY: as for the cron above; the router is built once per isolate.
      const fetch = yield* HttpRouter.toHttpEffect(appLayer).pipe(Effect.orDie)

      return { fetch }
    }).pipe(
      Effect.provide([
        Cloudflare.Hyperdrive.ConnectBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Workers.BrowserBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Workers.VersionMetadataBinding,
        // The runtime supplies RuntimeContext to init and to every event; the
        // phantom layer states that so binding clients can be captured at init.
        RuntimeContext.phantom,
      ]),
    ),
  )

/** Alchemy's generated bridge imports the default; resources are already bound. */
export default Effect.gen(function* () {
  const stack = yield* Stack
  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection.ref("Postgres")
  const bucket = yield* Cloudflare.R2.Bucket.ref("Bucket")

  return yield* makeServer({
    stage: stageOf(stack.stage),
    hostname: Option.none(),
    assets: Option.none(),
    hyperdrive,
    bucket,
  })
})
