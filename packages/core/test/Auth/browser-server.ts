// Local-only browser fixture: in-memory PGlite and captured email, never stage data.
import { createServer } from "node:http"
import { Auth } from "@digital-shelf/core/Auth/Auth"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"
import * as DbTest from "../layers/Db.ts"
import * as EmailTest from "../layers/EmailSender.ts"

const layer = Auth.layer.pipe(
  Layer.provideMerge(EmailTest.layerTest),
  Layer.provide(DbTest.layerTest),
  Layer.provide(
    ConfigProvider.layerAdd(
      ConfigProvider.fromUnknown({
        AUTH_SECRET: "scratch-browser-secret-at-least-thirty-two-characters",
        AUTH_BASE_URL: "http://localhost:3002",
      }),
    ),
  ),
)

const runtime = ManagedRuntime.make(layer)

const controls = { outage: false, signOutFailure: false, slow: false }

const handle = Effect.fn(function* (request: Request) {
  const path = new URL(request.url).pathname
  const emails = yield* EmailTest.EmailSenderTest

  if (path === "/api/__test/email-count")
    return Response.json({ count: (yield* emails.sent).length })

  if (path === "/api/__test/slow") {
    controls.slow = !controls.slow

    return Response.json({ slow: controls.slow })
  }

  if (controls.slow && path.startsWith("/api/auth/"))
    yield* Effect.sleep("2 seconds")

  if (path === "/api/__test/outage") {
    controls.outage = !controls.outage

    return Response.json({ outage: controls.outage })
  }

  if (path === "/api/__test/sign-out-failure") {
    controls.signOutFailure = !controls.signOutFailure

    return Response.json({ signOutFailure: controls.signOutFailure })
  }

  if (path === "/api/__test/open-link") {
    const sent = yield* emails.sent
    const email = sent.at(-1)

    return email
      ? Response.redirect(email.text.trim().split("\n").at(-1)!, 302)
      : new Response("No email", { status: 404 })
  }

  if (
    (controls.outage && path === "/api/auth/get-session") ||
    (controls.signOutFailure && path === "/api/auth/sign-out")
  )
    return Response.json({ message: "Test outage" }, { status: 503 })
  const auth = yield* Auth

  return yield* auth.handle(request)
})

const server = createServer((incoming, outgoing) => {
  void runtime.runPromise(
    Effect.gen(function* () {
      const chunks = yield* Effect.tryPromise(async () => {
        const body: Buffer[] = []

        for await (const chunk of incoming) body.push(Buffer.from(chunk))

        return Buffer.concat(body)
      })

      const headers = new Headers()

      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value)
          headers.set(key, Array.isArray(value) ? value.join(", ") : value)
      }

      const response = yield* handle(
        new Request(`http://localhost:3002${incoming.url}`, {
          method: incoming.method ?? "GET",
          headers,
          body: chunks.length ? chunks : null,
        }),
      )

      outgoing.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        "set-cookie": response.headers.getSetCookie(),
      })
      outgoing.end(
        Buffer.from(yield* Effect.promise(() => response.arrayBuffer())),
      )
    }).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => {
          outgoing.writeHead(500)
          outgoing.end("Scratch server failure")
        }),
      ),
    ),
  )
})

server.listen(1437, "127.0.0.1", () =>
  console.info(
    "Scratch auth listening on 127.0.0.1:1437; use Vite on localhost:3002",
  ),
)

process.on("SIGTERM", () => server.close(() => void runtime.dispose()))
