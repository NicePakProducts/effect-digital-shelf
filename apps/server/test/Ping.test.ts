import { Stage } from "alchemy/Stage"
import { expect, it } from "@effect/vitest"
import * as Core from "@app/core/test/layers/Features"
import * as EmailSenderTest from "@app/core/test/layers/EmailSender"
import * as ExecutionsTest from "@app/core/test/layers/Executions"
import * as R2BucketTest from "@app/core/test/layers/R2Bucket"
import * as DbAdapter from "@app/db/adapter"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as Http from "../src/http"

// Nothing listens on this port, so any connection attempt is refused at once.
const unreachable = Redacted.make("postgres://nobody:nothing@127.0.0.1:1/none")

/**
 * The Worker builds the application graph once per isolate without I/O.
 * Ping must answer without an invocation connection; health is the route
 * that asks for one.
 */
const ApplicationLayer = Http.RoutesLayer.pipe(
  Layer.provide(Layer.succeed(Stage, "dev")),
).pipe(
  Layer.provide(Core.ApiLayer.pipe(Layer.provide(EmailSenderTest.TestLayer))),
  Layer.provide(
    Layer.mergeAll(
      DbAdapter.layer(Effect.succeed(unreachable)),
      R2BucketTest.TestLayer,
      ExecutionsTest.TestLayer,
    ),
  ),
  Layer.provide(
    ConfigProvider.layerAdd(
      ConfigProvider.fromUnknown({
        AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
        AUTH_BASE_URL: "http://localhost",
      }),
    ),
  ),
)

const get = (path: string) =>
  Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(ApplicationLayer)

    return yield* handler.pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromClientRequest(
          HttpClientRequest.get(`http://localhost${path}`),
        ),
      ),
    )
  }).pipe(Effect.scoped)

it.effect("answers ping without a database connection", () =>
  Effect.gen(function* () {
    const response = yield* get("/api/v1/ping")

    expect(response.status).toBe(200)
  }),
)

it.effect("reports the database unavailable from health", () =>
  Effect.gen(function* () {
    const response = yield* get("/health")

    expect(response.status).toBe(503)
  }),
)
