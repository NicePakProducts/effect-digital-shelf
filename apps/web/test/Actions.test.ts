import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import {
  AuthActionError,
  createClient,
  makeAuthActions,
} from "../src/lib/auth-actions"
import { httpServer } from "./HttpServer"

it.effect(
  "reports unsuccessful email and sign-out responses as typed failures",
  () =>
    Effect.gen(function* () {
      const server = yield* httpServer((_request, response) => {
        response.writeHead(503, { "Content-Type": "application/json" })
        response.end('{"message":"Unavailable"}')
      })

      const actions = makeAuthActions(createClient({ baseURL: server.baseURL }))
      expect(
        yield* Effect.result(
          actions.requestLink({ email: "user@npbrands.com.au", redirect: "/" }),
        ),
      ).toEqual(Result.fail(new AuthActionError()))
      expect(yield* Effect.result(actions.signOut)).toEqual(
        Result.fail(new AuthActionError()),
      )
      yield* server.close
      expect(yield* Effect.result(actions.signOut)).toEqual(
        Result.fail(new AuthActionError()),
      )
    }).pipe(Effect.scoped),
)
