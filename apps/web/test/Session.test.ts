import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry"
import { createClient } from "../src/lib/auth-actions"
import { sessionAtom } from "../src/lib/auth-session"
import { httpServer } from "./HttpServer"

it.effect(
  "treats a misconfigured proxy's HTML response as a session error",
  () =>
    Effect.gen(function* () {
      const server = yield* httpServer((_request, response) => {
        response.setHeader("Content-Type", "text/html")
        response.end("<!doctype html><h1>SPA fallback</h1>")
      })

      const client = createClient({ baseURL: server.baseURL })
      yield* Effect.promise(() => client.useSession.get().refetch())
      expect(client.useSession.get().data).toBeNull()
      expect(client.useSession.get().error).not.toBeNull()
    }).pipe(Effect.scoped),
)

it.effect(
  "publishes pending, confirmed sign-out and lookup failures from the SDK",
  () =>
    Effect.gen(function* () {
      const server = yield* httpServer((_request, response) => {
        response.setHeader("Content-Type", "application/json")
        response.end("null")
      })

      const client = createClient({ baseURL: server.baseURL })
      const atom = sessionAtom(client.useSession)

      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      )

      registry.mount(atom)
      expect(registry.get(atom).isPending).toBe(true)
      yield* Effect.promise(() => client.useSession.get().refetch())
      expect(registry.get(atom)).toMatchObject({
        data: null,
        error: null,
        isPending: false,
      })
      yield* server.close
      yield* Effect.promise(() => client.useSession.get().refetch())
      expect(registry.get(atom).error).not.toBeNull()
    }).pipe(Effect.scoped),
)
