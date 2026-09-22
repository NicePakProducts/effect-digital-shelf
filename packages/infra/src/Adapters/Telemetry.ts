import { layer as TraceIdentity } from "@app/core/scrapes/trace"
import * as Layer from "effect/Layer"
import type * as LogLevel from "effect/LogLevel"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware"
import type * as OtlpExporter from "effect/unstable/observability/OtlpExporter"
import * as OtlpLogger from "effect/unstable/observability/OtlpLogger"
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization"
import * as OtlpTracer from "effect/unstable/observability/OtlpTracer"
import type { Stage } from "../Resources/Names"

/**
 * Exports invocation telemetry to Axiom with the Scrape trace identity and stage-specific levels.
 * Registered through Alchemy's `Telemetry.layer` at Worker init: the runtime bridge builds it into
 * every event's scope and closes that scope through `ctx.waitUntil`, so the flush never delays a
 * response (ADR 0007, #28). Production's Info log threshold suppresses the exporter's Debug failure messages.
 */
export interface TelemetryOptions {
  readonly axiomToken: Redacted.Redacted<string>
  readonly axiomDomain: string
  readonly stage: Stage
  readonly versionId: string
}

const levels = (stage: Stage) => {
  const level: LogLevel.LogLevel = stage === "prod" ? "Info" : "Debug"

  return Layer.mergeAll(
    Layer.succeed(Tracer.MinimumTraceLevel, level),
    Layer.succeed(References.MinimumLogLevel, level),
  )
}

/** @internal Allows exporter tests to supply an isolated HTTP transport. */
export const make = (
  options: TelemetryOptions,
  httpClient: Layer.Layer<HttpClient.HttpClient>,
): Layer.Layer<OtlpExporter.Flusher> => {
  const resource = {
    serviceName: "digital-shelf-server",
    serviceVersion: options.versionId,
    attributes: { "deployment.environment.name": options.stage },
  }

  const authorization = `Bearer ${Redacted.value(options.axiomToken)}`

  // The exporters live for one event and flush when its scope closes; an
  // interval export firing mid-event would race that close and drop the batch.
  const exportInterval = "1 hour"

  const OtlpLayer = Layer.mergeAll(
    OtlpTracer.layer({
      url: `https://${options.axiomDomain}/v1/traces`,
      headers: {
        Authorization: authorization,
        "X-Axiom-Dataset": "digital-shelf-traces",
      },
      resource,
      exportInterval,
      shutdownTimeout: "5 seconds",
    }),
    OtlpLogger.layer({
      url: `https://${options.axiomDomain}/v1/logs`,
      headers: {
        Authorization: authorization,
        "X-Axiom-Dataset": "digital-shelf-logs",
      },
      resource,
      exportInterval,
      shutdownTimeout: "5 seconds",
      mergeWithExisting: true,
    }),
  ).pipe(Layer.provide([OtlpSerialization.layerProtobuf, httpClient]))

  return TraceIdentity().pipe(
    Layer.provideMerge(OtlpLayer),
    Layer.provideMerge(levels(options.stage)),
    // Health probes run every few seconds and would dominate the trace volume.
    Layer.provideMerge(HttpMiddleware.layerTracerDisabledForUrls(["/health"])),
  )
}

export const layer = (
  options: TelemetryOptions,
): Layer.Layer<OtlpExporter.Flusher> => make(options, FetchHttpClient.layer)

export const layerDisabled = (stage: Stage): Layer.Layer<never> =>
  TraceIdentity().pipe(Layer.provideMerge(levels(stage)))
