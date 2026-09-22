import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import { SourceError } from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as AiGateway from "./packages/infra/src/Resources/AiGateway"
import * as Bucket from "./packages/infra/src/Resources/Bucket"
import { isDeployedStage, stageOf } from "./packages/infra/src/Resources/Names"
import * as Postgres from "./packages/infra/src/Resources/Postgres"
import Server from "./apps/server/src/Worker"

export default Alchemy.Stack(
  "DigitalShelf",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const context = yield* Alchemy.AlchemyContext
    const stageName = yield* Alchemy.Stage

    // `alchemy dev` emulates every resource locally under its own stage. Running
    // it on a deployed stage replaces and deletes the live Worker, Workflows
    // and bucket, so the two modes accept disjoint stage names.
    if (context.dev && isDeployedStage(stageName))
      return yield* invalidStage(
        `alchemy dev must not run on the deployed stage "${stageName}": omit --stage so Alchemy uses your private dev_<user> stage`,
      )

    // Alchemy's `state` commands evaluate the stack under the literal stage
    // "placeholder" to reach its state store; they apply nothing.
    const inspectingState = stageName === "placeholder"

    if (!context.dev && !inspectingState && !isDeployedStage(stageName))
      return yield* invalidStage(
        `Unsupported Digital Shelf stage "${stageName}"; deploy with --stage dev or --stage prod`,
      )

    const stage = stageOf(stageName)
    const databaseUrl = yield* Config.redacted("DATABASE_URL")

    const axiom = Option.all({
      domain: yield* Config.option(Config.string("AXIOM_DOMAIN")),
      token: yield* Config.option(Config.redacted("AXIOM_TOKEN")),
    })

    if (Option.isNone(axiom)) {
      if (stage === "prod")
        return yield* Effect.die(
          new Error(
            "prod deploy requires AXIOM_DOMAIN and AXIOM_TOKEN: the gateway's OTel export is declared from these values; deploying without them clears it",
          ),
        )

      yield* Effect.logWarning(
        "Axiom telemetry disabled for dev: AXIOM_DOMAIN or AXIOM_TOKEN unset; deploying clears the gateway's OTel exporter",
      )
    }

    const postgres = yield* Postgres.make({ stage, databaseUrl })
    const bucket = yield* Bucket.make(stage)

    if (!context.dev) yield* AiGateway.make(stage, axiom)

    const server = yield* Server.pipe(
      Effect.provideService(Cloudflare.Hyperdrive.Connection.Self, postgres),
      Effect.provideService(Cloudflare.R2.Bucket.Self, bucket),
    )

    return { url: server.url }
  }),
)

const invalidStage = (message: string) =>
  Effect.fail(new Config.ConfigError(new SourceError({ message })))
