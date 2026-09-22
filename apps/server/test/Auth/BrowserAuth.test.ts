import { expect, it } from "@effect/vitest"
import * as Api from "../../src/http"
import { AuthRoutesLayer } from "../../src/auth/routes"
import * as CoreTest from "@app/core/test/layers/Core"
import { EmailSenderTest } from "@app/core/test/layers/EmailSender"
import { Effect, FileSystem, Layer, Path } from "effect"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"
import * as HttpRouter from "effect/unstable/http/HttpRouter"

const PlatformLayer = HttpPlatform.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(FileSystem.layerNoop({}), Etag.layer, Path.layer),
  ),
)

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })(
  "Real browser authentication gate",
  (it) => {
    it.effect(
      "denies anonymous API access, accepts an emailed session and denies after cookie removal",
      () =>
        Effect.gen(function* () {
          const context =
            yield* Effect.context<Layer.Success<typeof CoreTest.TestLayer>>()

          const app = yield* Effect.acquireRelease(
            Effect.sync(() =>
              HttpRouter.toWebHandler(
                Layer.mergeAll(Api.layer, AuthRoutesLayer).pipe(
                  Layer.provide(Layer.succeedContext(context)),
                  Layer.provide(PlatformLayer),
                ),
                { disableLogger: true },
              ),
            ),
            (server) => Effect.promise(() => server.dispose()),
          )

          const emails = yield* EmailSenderTest
          yield* emails.clear

          const call = (path: string, init?: RequestInit) =>
            Effect.promise(() =>
              app.handler(new Request(`http://localhost${path}`, init)),
            )

          expect((yield* call("/api/v1/brands")).status).toBe(401)
          expect(
            (yield* call("/api/auth/sign-in/magic-link", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                origin: "http://localhost",
              },
              body: JSON.stringify({
                email: "api-browser@npbrands.com.au",
                callbackURL: "/",
              }),
            })).status,
          ).toBe(200)
          const sent = yield* emails.sent

          const verified = yield* Effect.promise(() =>
            app.handler(
              new Request(sent.at(-1)!.text.trim().split("\n").at(-1)!),
            ),
          )

          const cookies = verified.headers
            .getSetCookie()
            .map((cookie) => cookie.split(";")[0])
            .join("; ")

          expect(
            (yield* call("/api/v1/brands", { headers: { cookie: cookies } }))
              .status,
          ).toBe(200)
          expect(
            (yield* call("/api/auth/sign-out", {
              method: "POST",
              headers: { cookie: cookies, origin: "http://localhost" },
            })).status,
          ).toBe(200)
          expect((yield* call("/api/v1/brands")).status).toBe(401)
        }).pipe(Effect.scoped),
    )
  },
)
