import * as CoreTest from "@app/core/test/layers/Core"
import { CurrentUser, CurrentUserMiddleware } from "@app/protocol/auth/security"
import { BrandsHandlersLayer } from "../../src/handlers/brands"
import { ProductsHandlersLayer } from "../../src/handlers/products"
import { ProductVariantsHandlersLayer } from "../../src/handlers/products/variants"
import { RetailersHandlersLayer } from "../../src/handlers/retailers"
import { ListingsHandlersLayer } from "../../src/handlers/listings"
import { PagesHandlersLayer } from "../../src/handlers/pages"
import { ScrapesHandlersLayer } from "../../src/handlers/scrapes"
import { ExtractionsHandlersLayer } from "../../src/handlers/scrapes/extractions"
import { PingHandlersLayer } from "../../src/handlers/ping"
import { Api } from "@app/protocol/api"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError"
import * as Etag from "effect/unstable/http/Etag"
import * as HttpPlatform from "effect/unstable/http/HttpPlatform"

/**
 * Every group's handlers over core's test layers, with an authenticated
 * CurrentUser standing in for the Better Auth middleware. `HttpApiBuilder`
 * needs an implementation for every group on `Api`, so all of them are
 * built here and each test file drives the groups it cares about.
 */
export const CurrentUserMiddlewareLayer = Layer.succeed(
  CurrentUserMiddleware,
  (httpEffect) =>
    Effect.provideService(httpEffect, CurrentUser, {
      id: "user-1",
      email: "user@npbrands.com.au",
    }),
)

export const PlatformLayer = HttpPlatform.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(FileSystem.layerNoop({}), Etag.layer, Path.layer),
  ),
)

/** No session: protected groups answer the middleware's built-in 401. */
export const AnonymousMiddlewareLayer = Layer.succeed(
  CurrentUserMiddleware,
  () => Effect.fail(new HttpApiError.Unauthorized()),
)

const HandlersLayer = Layer.mergeAll(
  BrandsHandlersLayer,
  ProductsHandlersLayer,
  ProductVariantsHandlersLayer,
  RetailersHandlersLayer,
  ListingsHandlersLayer,
  PagesHandlersLayer,
  ScrapesHandlersLayer,
  ExtractionsHandlersLayer,
  PingHandlersLayer,
)

export const TestLayer = HandlersLayer.pipe(
  Layer.provideMerge(CoreTest.TestLayer),
  Layer.provideMerge(CurrentUserMiddlewareLayer),
  Layer.provideMerge(PlatformLayer),
)

export const AnonymousTestLayer = HandlersLayer.pipe(
  Layer.provideMerge(CoreTest.TestLayer),
  Layer.provideMerge(AnonymousMiddlewareLayer),
  Layer.provideMerge(PlatformLayer),
)

export const baseUrl = "http://localhost:3000/api/v1"

/**
 * The same in-memory pipeline `HttpApiTest.groups` runs, exposed as a plain
 * `HttpClient`. The generated client encodes a request against the contract,
 * so a malformed cursor or an out-of-range limit never leaves it; only a raw
 * request shows that the server itself answers 400.
 */
export const rawClient = Effect.gen(function* () {
  const context = yield* Effect.context<never>()

  const handler = yield* HttpRouter.toHttpEffect(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(Layer.succeedContext(context)),
    ),
  )

  return HttpClient.make(
    Effect.fnUntraced(function* (request) {
      // A request the contract refuses fails the route with a respondable
      // defect, which a running server turns into its status; here that is
      // `exitResponse`, so a raw request sees the same 400 a client would.
      const exit = yield* Effect.exit(
        handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromClientRequest(request),
          ),
        ),
      )

      if (Exit.isSuccess(exit)) {
        return HttpServerResponse.toClientResponse(exit.value)
      }

      const [response] = yield* HttpServerError.causeResponse(exit.cause)

      return HttpServerResponse.toClientResponse(response)
    }, Effect.scoped),
  )
})
