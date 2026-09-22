import { Cron } from "@app/core/cron"
import type { Executions } from "@app/core/executions"
import * as DbAdapter from "@app/db/adapter"
import * as ExecutionsAdapter from "@app/infra/Adapters/Executions"
import * as R2BucketAdapter from "@app/infra/Adapters/R2Bucket"
import * as TelemetryAdapter from "@app/infra/Adapters/Telemetry"
import { resourceName, stageOf } from "@app/infra/Resources/Names"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Stack } from "alchemy/Stack"
import { AlchemyContext, Stage, Telemetry } from "alchemy"
import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as ConfigKeys from "./ConfigKeys"
import { ExtractionWorkflow } from "./ExtractionWorkflow"
import { ScrapeWorkflow } from "./ScrapeWorkflow"
import { WorkflowLayers } from "./WorkflowLayers"
import { Brands } from "@app/core/brands"
import { Products } from "@app/core/products"
import { ProductVariants } from "@app/core/products/variants"
import { Retailers } from "@app/core/retailers"
import { Listings } from "@app/core/listings"
import { Pages } from "@app/core/pages"
import { Cascade } from "@app/core/cascade"
import { Auth } from "@app/core/auth"
import { Scrapes } from "@app/core/scrapes"
import { Extractions } from "@app/core/scrapes/extractions"
import { ScrapeRunner } from "@app/core/scrapes/runner"
import { ExtractionRunner } from "@app/core/scrapes/extractions/runner"
import { RoutesLayer } from "./http"
import { layer as ScrapeProvidersLayer } from "@app/core/scrapes/providers"
import { BrowserRendering } from "@app/core/scrapes/providers/browser-rendering"
import { layer as LanguageModelLayer } from "@app/core/scrapes/extractions/language-model"

export const FeaturesLayer = Layer.mergeAll(
  Brands.layer,
  Products.layer,
  ProductVariants.layer,
  Retailers.layer,
  Listings.layer,
  Pages.layer,
  Cascade.layer,
  Scrapes.layer,
  Extractions.layer,
  Auth.layer,
)

export const ApplicationLayer = Layer.mergeAll(FeaturesLayer, Cron.layer)

export const ScrapeWorkflowLayer = ScrapeRunner.layer

export const ExtractionWorkflowLayer = ExtractionRunner.layer

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

export default Cloudflare.Worker(
  "Server",
  {
    name: Effect.map(Stage, (stage) => resourceName(stageOf(stage), "server")),
    main: import.meta.url,
    compatibility: { date: "2026-09-01", flags: ["nodejs_compat"] },
    workersDev: true,
    assets: Effect.map(AlchemyContext, (context) =>
      context.dev
        ? undefined
        : assetsConfig(`${import.meta.dirname}/../../web/dist`),
    ),
    domain: Effect.gen(function* () {
      const context = yield* AlchemyContext

      if (context.dev) return null

      const hostname = (yield* Config.option(
        Config.string("SERVER_HOSTNAME"),
      )).pipe(Option.filter((name) => name !== ""))

      return Option.match(hostname, {
        onNone: () => null,
        onSome: (name) => ({ name, zoneName: "npbrands.au" }),
      })
    }),
    observability: { enabled: false },
    // The database and its Hyperdrive pool sit in AWS us-east-1, so the Worker
    // runs there too: a request pays one long hop instead of one per query.
    // Pinned rather than Smart Placement, which needs traffic dev never has.
    placement: { region: "aws:us-east-1" },
  },
  Effect.gen(function* () {
    const stack = yield* Stack
    const stage = stageOf(stack.stage)

    // Planning must depend on this stack's current resources, not stale state.
    // Standalone runtime evaluation has no root declarations to borrow.
    const postgres = yield* Effect.serviceOption(
      Cloudflare.Hyperdrive.Connection.Self,
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Cloudflare.Hyperdrive.Connection.ref("Postgres"),
          onSome: Effect.succeed,
        }),
      ),
    )

    const storage = yield* Effect.serviceOption(Cloudflare.R2.Bucket.Self).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Cloudflare.R2.Bucket.ref("Bucket"),
          onSome: Effect.succeed,
        }),
      ),
    )

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
          onNone: () => TelemetryAdapter.layerDisabled(stage),
          onSome: ({ domain, token }) =>
            Layer.unwrap(
              Effect.map(versionMetadata, ({ id }) =>
                TelemetryAdapter.layer({
                  axiomToken: token,
                  axiomDomain: domain,
                  stage: stage,
                  versionId: id,
                }),
              ),
            ),
        }),
      ),
    )

    const hyperdrive = yield* Cloudflare.Hyperdrive.Connect(postgres)

    const bucket = yield* Cloudflare.R2.ReadWriteBucket(storage)
    const browser = yield* Cloudflare.Browser("BROWSER")

    // Both classes register before any layer is built. Deferral lets every
    // invocation use the yielded handles without recursive Workflow init.
    const ExecutionsLayer: Layer.Layer<Executions.Service> = Layer.unwrap(
      Effect.sync(() => ExecutionsAdapter.layer({ scrape, extraction })),
    )

    // Built once per isolate; the database connection is memoised per event.
    const DatabaseLayer = DbAdapter.layer(hyperdrive.connectionString)

    const InfraLayer = Layer.mergeAll(
      DatabaseLayer,
      R2BucketAdapter.layer(bucket),
      ExecutionsLayer,
    )

    const ProvidersLayer = ScrapeProvidersLayer.pipe(
      Layer.provide([
        Layer.unwrap(
          Effect.map(browser.raw, (raw) =>
            Layer.succeed(BrowserRendering.Service, raw),
          ),
        ),
        FetchHttpClient.layer,
      ]),
    )

    const workflowLayers: WorkflowLayers["Service"] = {
      scrape: ScrapeWorkflowLayer.pipe(
        Layer.provide([InfraLayer, ProvidersLayer]),
      ),
      extraction: ExtractionWorkflowLayer.pipe(
        Layer.provide([InfraLayer, LanguageModelLayer]),
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
    const application = yield* Layer.build(
      ApplicationLayer.pipe(Layer.provideMerge(InfraLayer)),
    ).pipe(Effect.orDie)

    const cron = Context.get(application, Cron.Service)

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

    const HttpLayer = RoutesLayer.pipe(
      Layer.provide(Layer.succeed(Stage, stage)),
      Layer.provide(Layer.succeedContext(application)),
    )

    // SAFETY: as above; the router mounts the already-built application services.
    const fetch = yield* HttpRouter.toHttpEffect(HttpLayer).pipe(Effect.orDie)

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
