import { Gateway } from "alchemy/Cloudflare/AI"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { resourceName, type Stage } from "./Names.ts"

export const make = (stage: Stage) =>
  Gateway("AiGateway", {
    id: resourceName(stage, "ai-gateway"),
    collectLogs: true,
    authentication: true,
  }).pipe(RemovalPolicy.retain(stage === "prod"))
