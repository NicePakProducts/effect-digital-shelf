import { expect, it } from "@effect/vitest"
import { Db } from "@digital-shelf/core/Sql/Db"
import * as CoreTest from "@digital-shelf/core/test/layers/Core"
import * as TelemetryAdapter from "@digital-shelf/infra/Adapters/Telemetry"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Redacted from "effect/Redacted"
import * as Ref from "effect/Ref"
import * as References from "effect/References"
import * as Scope from "effect/Scope"
import * as Tracer from "effect/Tracer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as HttpEffect from "effect/unstable/http/HttpEffect"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as Http from "../src/Http.ts"

it.effect(
  "creates request roots with OTLP and leaves flushing and application cleanup to the caller's scope",
  () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = []
      const spans: Tracer.Span[] = []
      const closed: string[] = []
      const builds = yield* Ref.make(0)

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          requests.push(request)

          return HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: 200 }),
          )
        }),
      )

      const telemetry = Layer.effect(
        Tracer.Tracer,
        Effect.gen(function* () {
          const base = yield* Effect.tracer
          yield* Ref.update(builds, (n) => n + 1)

          return Tracer.make({
            span(options) {
              const span = base.span(options)
              spans.push(span)

              return span
            },
            context: base.context,
          })
        }),
      ).pipe(
        Layer.provideMerge(
          TelemetryAdapter.make(
            {
              axiomDomain: "example.test",
              axiomToken: Redacted.make("test-token"),
              stage: "prod",
              versionId: "request-test",
            },
            Layer.succeed(HttpClient.HttpClient, http),
          ),
        ),
      )

      const app = HttpRouter.add(
        "GET",
        "/probe",
        Effect.gen(function* () {
          expect((yield* HttpServerRequest.HttpServerRequest).url).toBe(
            "/probe",
          )
          expect(yield* Tracer.MinimumTraceLevel).toBe("Info")
          expect(yield* References.MinimumLogLevel).toBe("Info")
          yield* Effect.logInfo("request probe")

          return HttpServerResponse.text("ok")
        }).pipe(Effect.withSpan("Route.probe")),
      ).pipe(
        Layer.provide(
          Layer.effectDiscard(
            Effect.addFinalizer(() =>
              Effect.sync(() => {
                closed.push("app")
              }),
            ).pipe(Effect.withSpan("App.build")),
          ),
        ),
      )

      for (let invocation = 0; invocation < 2; invocation++) {
        const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
          Scope.close(scope, Exit.void),
        )

        const response = yield* Http.fetch(app, telemetry).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("https://example.test/probe"),
            ),
          ),
        )

        expect(response.status).toBe(200)
        expect(yield* Ref.get(builds)).toBe(invocation + 1)
        expect(closed).toHaveLength(invocation)
        expect(requests).toHaveLength(invocation * 2)

        const root = spans.filter((span) => span.name === "Server.fetch")[
          invocation
        ]!

        expect(Option.isNone(root.parent)).toBe(true)
        expect(root.sampled).toBe(true)
        expect(root.status._tag).toBe("Ended")

        for (const name of ["App.build", "Route.probe"]) {
          const child = spans.filter((span) => span.name === name)[invocation]!
          expect(child.traceId).toBe(root.traceId)
          expect(Option.getOrThrow(child.parent).spanId).toBe(root.spanId)
          expect(child.sampled).toBe(true)
        }

        yield* Scope.close(scope, Exit.void)
        expect(closed).toHaveLength(invocation + 1)
        expect(requests).toHaveLength((invocation + 1) * 2)

        const exported = requests.findLast((request) =>
          request.url.endsWith("/v1/traces"),
        )!

        expect(exported.body._tag).toBe("Uint8Array")

        if (Predicate.isTagged(exported.body, "Uint8Array")) {
          const body = new TextDecoder().decode(exported.body.body)
          expect(body).toContain("Server.fetch")
          expect(body).toContain("Route.probe")
        }
      }

      const roots = spans.filter((span) => span.name === "Server.fetch")
      expect(new Set(roots.map((span) => span.traceId)).size).toBe(2)
    }).pipe(Effect.scoped),
  { timeout: 20_000 },
)

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "server routes",
  (it) => {
    const handler = Effect.gen(function* () {
      const context =
        yield* Effect.context<Layer.Success<typeof CoreTest.layerTest>>()

      return yield* Http.fetch(
        Http.layer("dev").pipe(Layer.provide(Layer.succeedContext(context))),
        TelemetryAdapter.layerDisabled("dev"),
      )
    }).pipe(Effect.scoped)

    const request = (path: string) =>
      Effect.gen(function* () {
        const context =
          yield* Effect.context<Layer.Success<typeof CoreTest.layerTest>>()

        const webHandler = HttpEffect.toWebHandler(
          handler.pipe(Effect.provide(context)),
        )

        return yield* Effect.promise(() =>
          webHandler(new Request(`http://localhost${path}`)),
        )
      })

    it.effect("preserves RouteNotFound in the typed HTTP failure channel", () =>
      Effect.gen(function* () {
        const error = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("http://localhost/not-a-route"),
            ),
          ),
          Effect.flip,
        )

        expect(error).toMatchObject({
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- This is a partial assertion on an HTTP error, not an error constructor.
          _tag: "HttpServerError",
          // oxlint-disable-next-line anti-slop-effect/no-manual-tagged-construction -- This partial reason pattern intentionally omits RouteNotFound's request.
          reason: { _tag: "RouteNotFound" },
        })
      }),
    )

    it.effect(
      "returns 404 for unknown paths through the Worker fetch handler",
      () =>
        Effect.gen(function* () {
          for (const path of ["/", "/favicon.ico", "/not-a-route"]) {
            const response = yield* request(path)
            expect(response.status).toBe(404)
          }
        }),
    )

    it.effect(
      "serves the health query, docs, and middleware refusal through the per-request router",
      () =>
        Effect.gen(function* () {
          const health = yield* request("/health")
          expect(health.status).toBe(200)
          expect(yield* Effect.promise(() => health.json())).toEqual({
            ok: true,
            stage: "dev",
            db: "ok",
          })
          const docs = yield* request("/api/docs")
          expect(docs.status).toBe(200)
          expect(yield* Effect.promise(() => docs.text())).toContain(
            "api-reference",
          )
          const brands = yield* request("/api/v1/brands")
          expect(brands.status).toBe(401)
        }),
    )

    it.effect("returns 503 when the health query fails", () =>
      Effect.gen(function* () {
        const db = yield* Db

        yield* db.transaction(() =>
          Effect.gen(function* () {
            // The route joins this fiber's TransactionConnection through the
            // captured context, so the aborted real transaction makes the
            // health SELECT fail too; if that propagation ever changed, the
            // request would hang rather than fail.
            yield* db.execute("select 1 / 0").pipe(Effect.flip)

            const health = yield* request("/health")
            expect(health.status).toBe(503)
            expect(yield* Effect.promise(() => health.json())).toEqual({
              ok: false,
              stage: "dev",
              db: "unavailable",
            })
          }),
        )
      }),
    )

    it.effect("mounts the Better Auth handler", () =>
      Effect.gen(function* () {
        const response = yield* request("/api/auth/ok")
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toEqual({
          ok: true,
        })
      }),
    )
  },
)
