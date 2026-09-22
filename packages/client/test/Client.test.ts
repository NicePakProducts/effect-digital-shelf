import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import { ApiClient, layer } from "../src/index"
import { ApiClient as ReactiveApiClient } from "../src/reactivity"

it.effect(
  "builds the Fetch client without I/O and retains all API groups",
  () =>
    Effect.gen(function* () {
      const client = yield* ApiClient

      expect(Object.keys(client).sort()).toEqual([
        "brands",
        "extractions",
        "listings",
        "pages",
        "ping",
        "products",
        "retailers",
        "scrapes",
        "variants",
      ])
    }).pipe(Effect.provide(layer)),
)

it("retains the reactive query and mutation binding without starting a request", () => {
  expect(Atom.isAtom(ReactiveApiClient.query("ping", "get", {}))).toBe(true)
  expect(Atom.isAtom(ReactiveApiClient.mutation("brands", "create"))).toBe(true)
})
