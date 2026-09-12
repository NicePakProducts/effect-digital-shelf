import { expect, it } from "@effect/vitest"
import * as Core from "@digital-shelf/core/Layers"
import * as EmailSenderTest from "@digital-shelf/core/test/layers/EmailSender"
import * as ExecutionsTest from "@digital-shelf/core/test/layers/Executions"
import * as R2BucketTest from "@digital-shelf/core/test/layers/R2Bucket"
import * as DbAdapter from "@digital-shelf/infra/Adapters/Db"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as Http from "../src/Http.ts"

// Nothing listens on this port, so any connection attempt is refused at once.
const unreachable = Redacted.make("postgres://nobody:nothing@127.0.0.1:1/none")

/**
 * The Worker builds the whole application layer for every invocation, so a
 * layer that connected or queried while it was built would charge every
 * request one database round trip. Ping never touches the database and must
 * answer without a connection; health is the one route that asks for one.
 */
const appLayer = Http.layer("dev").pipe(
  Layer.provide(Core.Api.pipe(Layer.provide(EmailSenderTest.layerTest))),
  Layer.provide(
    Layer.mergeAll(
      DbAdapter.layer(Effect.succeed(unreachable)),
      R2BucketTest.layerTest,
      ExecutionsTest.layerTest,
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
    const handler = yield* HttpRouter.toHttpEffect(appLayer)

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
