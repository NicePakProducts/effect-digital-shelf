import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { fetchEnvelope } from "./Fetch.ts"

export default class SmokeWorkflow extends Cloudflare.Workflow<SmokeWorkflow>()(
  "SmokeWorkflow",
  Effect.gen(function* () {
    const browser = yield* Cloudflare.Browser("BROWSER")
    return Effect.fn(function* (input: { readonly url: string }) {
      const started = Date.now()
      const envelope = yield* Cloudflare.Workflows.task(
        "fetch",
        Effect.gen(function* () {
          const raw = yield* browser.raw
          return yield* fetchEnvelope(raw, input.url)
        }).pipe(Effect.orDie),
        { timeout: "2 minutes", retries: { limit: 0, delay: "1 second" } },
      )
      return { input, envelope, ranInWorkflow: true, stepMs: Date.now() - started }
    })
  }).pipe(Effect.provide(Cloudflare.Workers.BrowserBinding)),
) {}
