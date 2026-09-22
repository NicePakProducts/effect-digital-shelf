import { createServer, type RequestListener } from "node:http"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"

export const httpServer = (handler: RequestListener) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer(handler)),
      (server) =>
        Effect.promise(
          () => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
    )

    yield* Effect.tryPromise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", resolve)
        }),
    )
    const address = server.address()

    if (!address || Predicate.isString(address))
      return yield* Effect.fail(new Error("No test port"))

    return {
      baseURL: `http://127.0.0.1:${address.port}`,
      close: Effect.promise(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    }
  })
