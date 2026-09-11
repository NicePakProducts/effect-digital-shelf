import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { RootTraceId } from "@digital-shelf/core/Scraping/Trace"
import * as Telemetry from "@digital-shelf/infra/Adapters/Telemetry"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as References from "effect/References"
import * as Tracer from "effect/Tracer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { Buffer } from "node:buffer"

const traceId = "0123456789abcdef0123456789abcdef"

const annotations = Context.make(RootTraceId, Option.some(traceId))

describe("Telemetry adapter", () => {
  it("keeps the HTTP transport out of its requirements", () => {
    expectTypeOf<
      Layer.Services<ReturnType<typeof Telemetry.layer>>
    >().toEqualTypeOf<never>()
    expectTypeOf<
      Layer.Services<ReturnType<typeof Telemetry.layerDisabled>>
    >().toEqualTypeOf<never>()
  })

  it.effect(
    "flushes both protobuf signals on scope close using the wrapped OTLP tracer",
    () =>
      Effect.gen(function* () {
        const requests: HttpClientRequest.HttpClientRequest[] = []

        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request)

            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: 200 }),
            )
          }),
        )

        yield* Effect.gen(function* () {
          const tracer = yield* Effect.tracer

          const span = tracer.span({
            name: "identity-probe",
            root: true,
            annotations,
            parent: Option.none(),
            links: [],
            startTime: 0n,
            kind: "internal",
            sampled: true,
          })

          expect(span.traceId).toBe(traceId)
          expect(Option.isNone(span.parent)).toBe(true)
          span.end(1n, Exit.succeed(undefined))
          expect(yield* Tracer.MinimumTraceLevel).toBe("Info")
          expect(yield* References.MinimumLogLevel).toBe("Info")
          expect(yield* Effect.serviceOption(HttpClient.HttpClient)).toEqual(
            Option.none(),
          )

          yield* Effect.gen(function* () {
            expect((yield* Effect.currentSpan).traceId).toBe(traceId)
            yield* Effect.logInfo("probe log")
          }).pipe(Effect.withSpan("probe", { root: true, annotations }))
        }).pipe(
          Effect.provide(
            Telemetry.make(
              {
                axiomToken: Redacted.make("test-token"),
                axiomDomain: "example.test",
                stage: "prod",
                versionId: "test-version",
              },
              Layer.succeed(HttpClient.HttpClient, http),
            ),
          ),
          Effect.scoped,
        )

        expect(requests).toHaveLength(2)

        for (const [signal, dataset] of [
          ["traces", "digital-shelf-traces"],
          ["logs", "digital-shelf-logs"],
        ]) {
          const request = requests.find(
            (request) => request.url === `https://example.test/v1/${signal}`,
          )!

          expect(request.method).toBe("POST")
          expect(request.headers.authorization).toBe("Bearer test-token")
          expect(request.headers["x-axiom-dataset"]).toBe(dataset)
          expect(request.headers["content-type"]).toBe("application/x-protobuf")
          expect(request.body._tag).toBe("Uint8Array")

          if (Predicate.isTagged(request.body, "Uint8Array")) {
            expect(
              Buffer.from(request.body.body).includes(
                Buffer.from(traceId, "hex"),
              ),
            ).toBe(true)
            const text = new TextDecoder().decode(request.body.body)
            expect(text).toContain("digital-shelf-server")
            expect(text).toContain("deployment.environment.name")
            expect(text).toContain("prod")
            expect(text).toContain("test-version")
          }
        }
      }),
    { timeout: 20_000 },
  )

  for (const stage of ["dev", "prod"] as const)
    it.effect(`disabled ${stage} telemetry preserves identity and levels`, () =>
      Effect.gen(function* () {
        const level = stage === "prod" ? "Info" : "Debug"
        expect(yield* Tracer.MinimumTraceLevel).toBe(level)
        expect(yield* References.MinimumLogLevel).toBe(level)

        yield* Effect.gen(function* () {
          const span = yield* Effect.currentSpan
          expect(span.traceId).toBe(traceId)
          expect(Option.isNone(span.parent)).toBe(true)
          expect(span.sampled).toBe(true)
        }).pipe(Effect.withSpan("probe", { root: true, annotations }))

        yield* Effect.gen(function* () {
          expect((yield* Effect.currentSpan).sampled).toBe(stage === "dev")
        }).pipe(Effect.withSpan("debug-probe", { root: true, level: "Debug" }))
      }).pipe(Effect.provide(Telemetry.layerDisabled(stage))),
    )
})
