import { expect, it } from "@effect/vitest"
import {
  isCadenceDue,
  waitAfter,
} from "@digital-shelf/core/Scheduling/CadenceDue"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"

it.effect(
  "cadence waits from the latest attempt, shortening failures to the retry interval",
  () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      const retry = Duration.days(1)
      expect(isCadenceDue(Option.none(), "monthly", retry, now)).toBe(true)
      const success = {
        status: "success",
        createdAt: DateTime.subtractDuration(now, Duration.hours(2)),
      } as const
      expect(isCadenceDue(Option.some(success), "daily", retry, now)).toBe(
        false,
      )
      expect(
        Duration.toMillis(
          waitAfter(
            { ...success, status: "failed" },
            "daily",
            Duration.days(2),
          ),
        ),
      ).toBe(Duration.toMillis(retry))
      expect(
        Duration.toMillis(
          waitAfter({ ...success, status: "failed" }, "monthly", retry),
        ),
      ).toBe(Duration.toMillis(retry))
      expect(
        isCadenceDue(
          Option.some({
            status: "failed",
            createdAt: DateTime.subtractDuration(now, retry),
          }),
          "monthly",
          retry,
          now,
        ),
      ).toBe(true)
      expect(
        isCadenceDue(
          Option.some({ ...success, status: "failed" }),
          "monthly",
          retry,
          now,
        ),
      ).toBe(false)
    }),
)
