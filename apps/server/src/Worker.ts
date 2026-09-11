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
import type { RuntimeContext } from "alchemy/RuntimeContext"
import { Stack } from "alchemy/Stack"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as ConfigKeys from "./ConfigKeys.ts"
import { ExtractionWorkflow } from "./ExtractionWorkflow.ts"
import * as Http from "./Http.ts"
import { ScrapeWorkflow } from "./ScrapeWorkflow.ts"
import { WorkflowLayers } from "./WorkflowLayers.ts"

export const makeServer = (options: {
  readonly stage: Stage
  readonly hostname: Option.Option<string>
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
      domain: Option.match(options.hostname, {
        onNone: () => null,
        onSome: (name) => ({ name, zoneName: "npbrands.au" }),
      }),
      observability: { enabled: false },
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

      const telemetry: Layer.Layer<never, never, RuntimeContext> = Layer.unwrap(
        Effect.map(versionMetadata, ({ id }) =>
          Option.match(axiom, {
            onNone: () => TelemetryAdapter.layerDisabled(options.stage),
            onSome: ({ domain, token }) =>
              TelemetryAdapter.layer({
                axiomToken: token,
                axiomDomain: domain,
                stage: options.stage,
                versionId: id,
              }),
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

      const adapters = Layer.mergeAll(
        Layer.unwrap(Effect.map(hyperdrive.connectionString, DbAdapter.layer)),
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
        scrape: Core.ScrapeWorkflow.pipe(
          Layer.provide([adapters, providers]),
          Layer.provideMerge(telemetry),
        ),
        extraction: Core.ExtractionWorkflow.pipe(
          Layer.provide([adapters, Core.LanguageModelLive]),
          Layer.provideMerge(telemetry),
        ),
      }

      const scrape = yield* ScrapeWorkflow.pipe(
        Effect.provideService(WorkflowLayers, workflowLayers),
      )

      const extraction = yield* ExtractionWorkflow.pipe(
        Effect.provideService(WorkflowLayers, workflowLayers),
      )

      yield* Cloudflare.Workers.cron("* * * * *", () =>
        Effect.gen(function* () {
          const report = yield* (yield* Cron).tick()
          yield* Effect.logInfo(JSON.stringify(report))
        }).pipe(
          Effect.provide(
            Core.Cron.pipe(
              Layer.provide(adapters),
              Layer.provideMerge(telemetry),
            ),
          ),
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.logError("Cron invocation failed", cause),
          ),
        ),
      )

      const appLayer = Http.layer(options.stage).pipe(
        Layer.provide(Core.Api.pipe(Layer.provide(Core.EmailSenderLive))),
        Layer.provide(adapters),
      )

      return {
        fetch: Http.fetch(appLayer, telemetry),
      }
    }).pipe(
      Effect.provide([
        Cloudflare.Hyperdrive.ConnectBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Workers.BrowserBinding,
        Cloudflare.Workers.CronEventSourceLive,
        Cloudflare.Workers.VersionMetadataBinding,
      ]),
    ),
  )

/** Alchemy's generated bridge imports the default; resources are already bound. */
export default Effect.gen(function* () {
  const { stage } = yield* Stack
  const hyperdrive = yield* Cloudflare.Hyperdrive.Connection.ref("Postgres")
  const bucket = yield* Cloudflare.R2.Bucket.ref("Bucket")

  return yield* makeServer({
    stage: stageOf(stage),
    hostname: Option.none(),
    hyperdrive,
    bucket,
  })
})
