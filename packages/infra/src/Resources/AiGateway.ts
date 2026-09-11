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
          // The API needs the literal header, so the unwrapped token is cleartext in Alchemy state (#64).
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
    // An empty array clears the exporter just as omission does; declared state is authoritative (#64).
    otel: otelOf(axiom),
  }).pipe(RemovalPolicy.retain(stage === "prod"))
