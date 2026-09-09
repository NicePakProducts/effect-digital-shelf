# Apps are composition roots; infra implements core's ports

The runtime for this effort is one Cloudflare Worker hosting the `HttpApi` and the Better Auth handler, the one-minute cron and the Scrape and Extraction Workflows. That Worker module lives in `apps/server` (`@digital-shelf/server`), the **composition root**: it declares the Effect-form `Cloudflare.Worker` and `Cloudflare.Workflow` classes, registers the cron, mounts the API, and composes core's per-entrypoint layers over the platform adapters per request or Workflow step. It holds no rules. `packages/infra` holds two kinds of module: **resources** (`Resources/*`, the Alchemy declarations and the naming convention) and **adapters** (`Adapters/*`, layers that satisfy the tags core declares, `Sql/Db`, `Storage/R2Bucket`, `Scheduling/Executions`, from Cloudflare binding values), plus the committed migrations. A **port** is a tag core owns whose interface is written in core's vocabulary and names no platform type; an adapter is infra's implementation of it. `alchemy.run.ts` stays at the repository root and imports the app.

Dependency direction: `apps/*` on `api`, `core`, `infra` and `domain`; `infra` on `core` and `domain` only, never on `api` or an app. Adapters are functions of binding values, so they are tested with fakes and without Alchemy; the executions adapter takes the two Workflow bindings as values and never imports the Workflow classes, or the dependency would reverse.

## Considered options

- **The Worker module in infra** (`packages/infra/src/Workers/`). Rejected: it mixes reusable platform implementations with one application's composition, and the resulting `infra → api` edge makes that line harder to hold once a second deployable exists.
- **`apps/api`.** Rejected: the name understates a Worker that also runs the cron and the Workflows.
- **`apps/worker`.** Rejected: names the runtime rather than the responsibility, and stops distinguishing anything once a second Worker exists.

## Consequences

- ADR 0005's placement of the cron and Workflow adapters in infra is superseded; they are composition in `apps/server`.
- The dashboard is `apps/web`. The MCP surface, when it arrives, is `/mcp` on the same Worker and host as the API, so cookies and OAuth metadata share one origin.
- Infra's adapters are the seam core's tests already cross with fakes (ADR 0003); adding an adapter never changes a core interface.
