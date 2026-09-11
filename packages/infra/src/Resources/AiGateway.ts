import { Gateway, type GatewayOtel } from "alchemy/Cloudflare/AI"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import { resourceName, type Stage } from "./Names.ts"

export interface Axiom {
  readonly domain: string
  readonly token: Redacted.Redacted<string>
}

export const otelOf = (axiom: Option.Option<Axiom>): GatewayOtel[] =>
  Option.match(axiom, {
    onNone: () => [],
    onSome: ({ domain, token }) => [
      {
        url: `https://${domain}/v1/traces`,
        headers: {
          Authorization: `Bearer ${Redacted.value(token)}`,
          "X-Axiom-Dataset": "digital-shelf-traces",
        },
        contentType: "protobuf",
      },
    ],
  })

export const make = (stage: Stage, axiom: Option.Option<Axiom>) =>
  Gateway("AiGateway", {
    id: resourceName(stage, "ai-gateway"),
    collectLogs: true,
    authentication: true,
    // Omitting otel wipes the exporter on any gateway update (#64).
    otel: otelOf(axiom),
  }).pipe(RemovalPolicy.retain(stage === "prod"))
