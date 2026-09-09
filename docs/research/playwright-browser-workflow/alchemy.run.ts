import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import SmokeWorker from "./src/Worker.ts"

export default Alchemy.Stack(
  "PlaywrightWorkflowSmoke",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const worker = yield* SmokeWorker
    return { url: worker.url }
  }),
)
