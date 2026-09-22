import type { Cadence } from "@app/schema/cadence"
import * as Duration from "effect/Duration"

/** Shared intervals for SQL selection and the pure cadence predicate. */
export const cadenceInterval: Record<Cadence, Duration.Duration> = {
  daily: Duration.days(1),
  weekly: Duration.days(7),
  fortnightly: Duration.days(14),
  monthly: Duration.days(30),
}
