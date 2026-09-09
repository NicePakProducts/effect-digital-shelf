import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import { fetchEnvelope } from "./Fetch.ts"
import SmokeWorkflow from "./Workflow.ts"

export default Cloudflare.Worker(
  "PlaywrightWorkflowSmoke",
  {
    name: "digital-shelf-playwright-workflow-smoke",
    main: import.meta.url,
    compatibility: { date: "2026-09-01", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const workflow = yield* SmokeWorkflow
    const browser = yield* Cloudflare.Browser("BROWSER")
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://smoke")
        const target = url.searchParams.get("url") ?? "https://example.com/"
        switch (url.pathname) {
          case "/run": {
            const instance = yield* workflow.create({ params: { url: target } })
            return yield* HttpServerResponse.json({ id: instance.id }, { status: 202 })
          }
          case "/status": {
            const id = url.searchParams.get("id")
            if (id === null) {
              return yield* HttpServerResponse.json({ error: "id required" }, { status: 400 })
            }
            const instance = yield* workflow.get(id)
            const status = yield* instance.status()
            return yield* HttpServerResponse.json(status)
          }
          case "/direct": {
            const raw = yield* browser.raw
            const envelope = yield* fetchEnvelope(raw, target)
            return yield* HttpServerResponse.json({ envelope, ranInWorkflow: false })
          }
          default:
            return yield* HttpServerResponse.json({
              routes: ["/run?url=", "/status?id=", "/direct?url="],
            })
        }
      }).pipe(Effect.orDie),
    }
  }).pipe(Effect.provide(Cloudflare.Workers.BrowserBinding)),
)
