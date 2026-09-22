import { resolve } from "node:path"
import { expect, it } from "@effect/vitest"
import { AlchemyContext, Stage } from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Output from "alchemy/Output"
import * as Provider from "alchemy/Provider"
import { Stack } from "alchemy/Stack"
import { inMemoryState, type ResourceState } from "alchemy/State"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Postgres from "@app/infra/Resources/Postgres"
import * as Bucket from "@app/infra/Resources/Bucket"
import { stageOf } from "@app/infra/Resources/Names"
import Server from "../src/Worker"
import * as ConfigKeys from "../src/ConfigKeys"

const config = {
  AI_GATEWAY_ACCOUNT_ID: "offline-account",
  AI_GATEWAY_ID: "offline-gateway",
  AI_GATEWAY_TOKEN: "offline-gateway-token",
  AUTH_SECRET: "offline-at-least-thirty-two-characters",
  AUTH_BASE_URL: "http://localhost",
  POSTMARK_FROM: "offline@example.test",
  POSTMARK_SERVER_TOKEN: "offline-postmark-token",
  SCRAPPEY_API_KEY: "offline-scrappey-token",
}

const origin = {
  scheme: "postgres",
  host: "localhost",
  port: 1,
  database: "offline",
  user: "offline",
  password: Redacted.make("offline"),
}

const upstream = {
  Postgres: { hyperdriveId: "current-postgres", origin },
  Bucket: { bucketName: "current-bucket", jurisdiction: "default" },
  Server: { workerName: "current-server" },
  ScrapeWorkflow: { workflowName: "current-scrape-workflow" },
  ExtractionWorkflow: { workflowName: "current-extraction-workflow" },
}

const persisted = (
  id: string,
  resourceType: string,
  attr: ResourceState["attr"],
): ResourceState => ({
  status: "created",
  resourceType,
  namespace: undefined,
  fqn: id,
  logicalId: id,
  instanceId: "offline",
  providerVersion: 0,
  downstream: [],
  bindings: [],
  props: {},
  attr: attr ?? {},
})

const staleState = {
  Postgres: persisted("Postgres", Cloudflare.Hyperdrive.Connection.Type, {
    hyperdriveId: "persisted-postgres",
    origin,
  }),
  Bucket: persisted("Bucket", Cloudflare.R2.Bucket.Type, {
    bucketName: "persisted-bucket",
    jurisdiction: "default",
  }),
}

for (const scenario of [
  {
    stage: "dev_local",
    dev: true,
    hostname: "ignored.example.test",
    expectedDomain: null,
  },
  { stage: "dev", dev: false, hostname: undefined, expectedDomain: null },
  { stage: "dev", dev: false, hostname: "", expectedDomain: null },
  {
    stage: "prod",
    dev: false,
    hostname: "shelf.apps.npbrands.au",
    expectedDomain: { name: "shelf.apps.npbrands.au", zoneName: "npbrands.au" },
  },
]) {
  it.effect(
    `actual Worker plans ${scenario.stage}/${String(scenario.hostname)} without invocation bindings or database I/O`,
    () => {
      const stack = Stack.of({
        name: "DigitalShelf",
        stage: scenario.stage,
        resources: {},
        bindings: {},
        actions: {},
      })

      return Effect.gen(function* () {
        const profile = stageOf(scenario.stage)

        const postgres = yield* Postgres.make({
          stage: profile,
          databaseUrl: Redacted.make(
            "postgres://offline:offline@localhost:1/offline",
          ),
        })

        const bucket = yield* Bucket.make(profile)

        const worker = yield* Server.pipe(
          Effect.provideService(
            Cloudflare.Hyperdrive.Connection.Self,
            postgres,
          ),
          Effect.provideService(Cloudflare.R2.Bucket.Self, bucket),
        )

        const name = yield* Output.evaluate(
          Output.asOutput(worker.Props.name),
          upstream,
        )

        const assets = yield* Output.evaluate(
          Output.asOutput(worker.Props.assets),
          upstream,
        )

        const domain = yield* Output.evaluate(
          Output.asOutput(worker.Props.domain),
          upstream,
        )

        const bindings = yield* Output.evaluate(
          stack.bindings.Server ?? [],
          upstream,
        )

        const env = yield* Output.evaluate(worker.Props.env, upstream)

        expect(worker.LogicalId).toBe("Server")
        expect(worker.Type).toBe("Cloudflare.Worker")
        expect(name).toBe(`digital-shelf-server-${profile}`)
        expect(domain).toEqual(scenario.expectedDomain)
        expect(assets).toEqual(
          scenario.dev
            ? undefined
            : {
                directory: expect.stringMatching(/\/web\/dist$/),
                notFoundHandling: "single-page-application",
                runWorkerFirst: ["/api/*", "/health"],
              },
        )

        if (assets && !Predicate.isString(assets))
          expect(resolve(assets.directory)).toBe(
            resolve(import.meta.dirname, "../../web/dist"),
          )
        expect(worker.Props.main).toMatch(/\/apps\/server\/src\/Worker\.ts$/)
        expect(worker.Props.compatibility).toEqual({
          date: "2026-09-01",
          flags: ["nodejs_compat"],
        })
        expect(worker.Props.workersDev).toBe(true)
        expect(worker.Props.observability).toEqual({ enabled: false })
        expect(worker.Props.placement).toEqual({ region: "aws:us-east-1" })
        expect(Object.keys(stack.resources).sort()).toEqual([
          "Bucket",
          "ExtractionWorkflow",
          "Postgres",
          "ScrapeWorkflow",
          "Server",
        ])
        expect(postgres.RemovalPolicy).toBe("retain")
        expect(bucket.RemovalPolicy).toBe("retain")
        expect(postgres.Props.name).toBe(
          profile === "prod" ? "digital-shelf" : "digital-shelf-dev",
        )
        expect(bucket.Props.name).toBe(`digital-shelf-bucket-${profile}`)
        expect(
          bindings.flatMap((binding) => binding.data.bindings ?? []),
        ).toEqual(
          expect.arrayContaining([
            { type: "hyperdrive", name: "Postgres", id: "current-postgres" },
            {
              type: "r2_bucket",
              name: "Bucket",
              bucketName: "current-bucket",
              jurisdiction: undefined,
            },
            { type: "browser", name: "BROWSER" },
            { type: "version_metadata", name: "CF_VERSION_METADATA" },
            {
              type: "workflow",
              name: "ScrapeWorkflow",
              workflowName: "current-scrape-workflow",
              className: "ScrapeWorkflow",
            },
            {
              type: "workflow",
              name: "ExtractionWorkflow",
              workflowName: "current-extraction-workflow",
              className: "ExtractionWorkflow",
            },
          ]),
        )
        expect(bindings.flatMap((binding) => binding.data.crons ?? [])).toEqual(
          ["* * * * *"],
        )
        expect(Object.keys(worker.Props.exports ?? {}).sort()).toEqual([
          "ExtractionWorkflow",
          "ScrapeWorkflow",
          "default",
        ])

        for (const key of [
          ...ConfigKeys.requiredKeys,
          ...ConfigKeys.secretKeys,
        ]) {
          expect(env).toHaveProperty(key)
          expect(Redacted.isRedacted(env?.[key])).toBe(true)
        }

        expect(JSON.stringify(env)).not.toContain(config.AUTH_SECRET)
      }).pipe(
        // An empty installed provider registry cannot deploy or read cloud resources.
        // Alchemy supplies an empty WorkerEnvironment for planning: eagerly reading
        // Hyperdrive, R2, browser or version metadata would fail this real init.
        Effect.provide(
          Layer.effect(Cloudflare.Providers, Provider.collection([])),
        ),
        Effect.provide(
          inMemoryState(
            scenario.stage === "prod"
              ? { DigitalShelf: { prod: staleState } }
              : {},
          ),
        ),
        Effect.provideService(Stack, stack),
        Effect.provideService(Stage, scenario.stage),
        Effect.provideService(AlchemyContext, {
          dev: scenario.dev,
          adopt: false,
          dotAlchemy: "/unused",
        }),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            ...config,
            SERVER_HOSTNAME: scenario.hostname,
            AXIOM_DOMAIN:
              scenario.stage === "prod" ? "offline.example.test" : undefined,
            AXIOM_TOKEN:
              scenario.stage === "prod" ? "offline-axiom-token" : undefined,
          }),
        ),
        Effect.scoped,
      )
    },
  )
}

it.effect(
  "standalone Worker resolves fallback root refs from installed in-memory state",
  () => {
    const stack = Stack.of({
      name: "DigitalShelf",
      stage: "dev",
      resources: {},
      bindings: {},
      actions: {},
    })

    return Effect.gen(function* () {
      const worker = yield* Server

      const bindings = yield* Output.evaluate(
        stack.bindings.Server ?? [],
        upstream,
      )

      expect(worker.LogicalId).toBe("Server")
      expect(Object.keys(stack.resources).sort()).toEqual([
        "ExtractionWorkflow",
        "ScrapeWorkflow",
        "Server",
      ])
      expect(
        bindings.flatMap((binding) => binding.data.bindings ?? []),
      ).toEqual(
        expect.arrayContaining([
          { type: "hyperdrive", name: "Postgres", id: "persisted-postgres" },
          {
            type: "r2_bucket",
            name: "Bucket",
            bucketName: "persisted-bucket",
            jurisdiction: undefined,
          },
        ]),
      )
    }).pipe(
      Effect.provide(
        Layer.effect(Cloudflare.Providers, Provider.collection([])),
      ),
      Effect.provide(inMemoryState({ DigitalShelf: { dev: staleState } })),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, "dev"),
      Effect.provideService(AlchemyContext, {
        dev: false,
        adopt: false,
        dotAlchemy: "/unused",
      }),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown(config),
      ),
      Effect.scoped,
    )
  },
)
