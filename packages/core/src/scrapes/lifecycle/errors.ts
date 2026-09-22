export * as LifecycleErrors from "./errors"

import * as Data from "effect/Data"
import type { LifecycleStatuses } from "@app/schema/scraping-vocabulary"

type LifecycleStatus = (typeof LifecycleStatuses)[number]

export class TransitionRejected extends Data.TaggedError("TransitionRejected")<{
  readonly kind: "scrape" | "extraction"
  readonly id: string
  readonly from: LifecycleStatus
  readonly to: LifecycleStatus
  readonly observed: LifecycleStatus | null
}> {}
