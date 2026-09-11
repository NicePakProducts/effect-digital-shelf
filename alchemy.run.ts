import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as AiGateway from "./packages/infra/src/Resources/AiGateway.ts"
import * as Bucket from "./packages/infra/src/Resources/Bucket.ts"
import { stageOf } from "./packages/infra/src/Resources/Names.ts"
import * as Postgres from "./packages/infra/src/Resources/Postgres.ts"
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- makeServer is an Alchemy resource factory, not an Effect service constructor
import { makeServer } from "./apps/server/src/Worker.ts"

export default Alchemy.Stack(
  "DigitalShelf",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = stageOf(yield* Alchemy.Stage)
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

    const hostname = (yield* Config.option(
      Config.string("SERVER_HOSTNAME"),
    )).pipe(Option.filter((name) => name !== ""))

    const hyperdrive = yield* Postgres.make({ stage, databaseUrl })
    const bucket = yield* Bucket.make(stage)
    yield* AiGateway.make(stage, axiom)
    const server = yield* makeServer({ stage, hostname, hyperdrive, bucket })

    return { url: server.url }
  }),
)
