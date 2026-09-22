import type { ScrapeRunner } from "@app/core/scrapes/runner"
import type { ExtractionRunner } from "@app/core/scrapes/extractions/runner"
import type { RuntimeContext } from "alchemy/RuntimeContext"
import type { ConfigError } from "effect/Config"
import * as Context from "effect/Context"
import type * as Layer from "effect/Layer"
import type { SqlError } from "effect/unstable/sql/SqlError"

/** Layer recipes captured at init, built only within a scoped durable step. */
export class WorkflowLayers extends Context.Service<
  WorkflowLayers,
  {
    readonly scrape: Layer.Layer<
      ScrapeRunner.Service,
      ConfigError | SqlError,
      RuntimeContext
    >
    readonly extraction: Layer.Layer<
      ExtractionRunner.Service,
      ConfigError | SqlError,
      RuntimeContext
    >
  }
>()("@app/server/WorkflowLayers") {}
