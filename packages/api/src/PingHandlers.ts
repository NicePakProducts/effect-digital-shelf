import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder"
import { RootApi } from "./RootApi.ts"

export const layer = HttpApiBuilder.group(RootApi, "ping", (handlers) =>
  handlers.handle("get", () =>
    Effect.gen(function* () {
      const timestamp = yield* DateTime.now

      return { message: "pong", timestamp }
    }),
  ),
)
