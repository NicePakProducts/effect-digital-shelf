import { transitionExtraction } from "@digital-shelf/core/Scraping/Transitions"
import * as Effect from "effect/Effect"
import * as CoreTest from "../layers/Core.ts"
import {
  reset,
  seed,
  successfulScrape,
  extraction,
} from "../fixtures/Scraping.ts"
import { expect, it } from "@effect/vitest"
import {
  canTransition,
  isTerminal,
  classifyMissedTransition,
} from "@digital-shelf/core/Scraping/Transitions"
import { traceparentOf } from "@digital-shelf/core/Scraping/Trace"
import { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

it("transitions are terminal and missed writes distinguish replay from rejection", () => {
  expect(canTransition("pending", "running")).toBe(true)
  expect(canTransition("pending", "failed")).toBe(true)
  expect(canTransition("running", "success")).toBe(true)
  expect(canTransition("success", "failed")).toBe(false)
  expect(canTransition("failed", "success")).toBe(false)
  expect(isTerminal("failed")).toBe(true)
  expect(isTerminal("success")).toBe(true)
  expect(isTerminal("running")).toBe(false)
  expect(classifyMissedTransition("running", Option.some("running"))).toBe(
    "already_applied",
  )
  expect(classifyMissedTransition("success", Option.some("failed"))).toBe(
    "rejected",
  )
  expect(classifyMissedTransition("success", Option.none())).toBe("rejected")
  expect(
    traceparentOf(
      Schema.decodeUnknownSync(ScrapeId)(
        "00000000-0000-4000-8000-000000000001",
      ),
      "0123456789abcdef",
    ),
  ).toBe("00-00000000000040008000000000000001-0123456789abcdef-01")
})

it.layer(CoreTest.layerTest, { timeout: "60 seconds" })(
  "Extraction transitions",
  (it) => {
    it.effect(
      "conditional writes classify apply, replay and rejected late outcomes",
      () =>
        Effect.gen(function* () {
          yield* reset

          const row = yield* extraction(
            (yield* successfulScrape((yield* (yield* seed()).listing).parent))
              .id,
            1,
            "pending",
          )

          expect(
            (yield* transitionExtraction(row.id, "pending", "running", {}))
              .result,
          ).toBe("applied")
          expect(
            (yield* transitionExtraction(row.id, "pending", "running", {}))
              .result,
          ).toBe("already_applied")
          yield* transitionExtraction(row.id, "running", "failed", {})
          expect(
            yield* Effect.flip(
              transitionExtraction(row.id, "running", "success", {}),
            ),
          ).toMatchObject({
            _tag: "TransitionRejected",
            kind: "extraction",
            id: row.id,
            observed: "failed",
          })
        }),
    )
  },
)
