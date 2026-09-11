import type { ScrapeRunner } from "@digital-shelf/core/Scraping/ScrapeRunner"
import type { ExtractionRunner } from "@digital-shelf/core/Scraping/ExtractionRunner"
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
      ScrapeRunner,
      ConfigError | SqlError,
      RuntimeContext
    >
    readonly extraction: Layer.Layer<
      ExtractionRunner,
      ConfigError | SqlError,
      RuntimeContext
    >
  }
>()("@digital-shelf/server/WorkflowLayers") {}
