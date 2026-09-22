# The api package holds contracts and handlers behind a closed contract graph

_Placement and wiring superseded by [ADR 0011](0011-explicit-packages-and-feature-owned-persistence.md); the historical decision below is retained._

`packages/api` holds both the `HttpApi` contracts and the handlers that implement them, and therefore depends on `core`. Two kinds of module live side by side in each context folder. **Contract modules** (`RootApi.ts`, `<Area>/<Feature>Api.ts`, `<Area>/<Feature>Wire.ts`, `Auth/Security.ts`) declare groups, endpoints, wire projections, the `CurrentUser` service and the `CurrentUserMiddleware` tag; they import only other contract modules, `@digital-shelf/domain` and Effect. `<Area>/Errors.ts` is also a contract module, providing the per-status annotation of domain errors. **Execution modules** (`<Area>/<Feature>Handlers.ts`, `Auth/CurrentUserMiddleware.ts`, `Api.ts`) implement the groups over core's feature services, implement the middleware over core's `Auth`, and compose `HttpApiBuilder.layer(RootApi)` with every group and middleware provided, leaving `Db` and the platform tags for infra. `Auth/AuthRoutes.ts` is also an execution module, mounting the Better Auth routes. A boundaries test walks the import graph from every contract module, re-exports included, and fails if it reaches core, a test module or any execution module.

We chose this over a fifth `server` package because the contract and the handler for one group describe the same feature and belong together, the repo has one Worker family and one future dashboard, and Effect gives no reason to separate them: `HttpApiClient.make(RootApi)` and `OpenApi.fromApi(RootApi)` consume contract metadata and never discover handlers. What the separate package would have guaranteed by the dependency graph, the closed contract graph guarantees by test, which is cheap here because core already enforces its layout the same way (ADR 0003).

## Considered options

- **A `server` package between core and infra.** Rejected: a fifth package's configuration and wiring for the sake of a property a test can hold, and it would pull the feature's contract and handler apart.
- **Handlers in infra beside the Worker entrypoint.** Rejected: infra is Alchemy resources, the Postgres layer, migrations and bindings; request handling does not belong with deployment.
- **Handlers in core.** Rejected: core would import api and become HTTP-aware, breaking ADR 0003.
- **A filename ban on importing core.** Rejected as insufficient: a contract could import a helper that imports a handler. The rule is a closed graph, not a per-file import list.

## Consequences

- Any client, the dashboard or an MCP wrapper, imports contract modules only, through the package's subpath exports, and never `Api.ts`, a `*Handlers.ts` module or `Auth/CurrentUserMiddleware.ts`. A client package carries its own boundaries test asserting exactly that; nothing from core can reach a browser bundle by accident.
- api's `package.json` depends on core, so a client's install graph includes core's dependencies (domain, Effect, Drizzle today) without bundling them.
- Cron and Workflow adapters are not request handling and hold no rules. _Amended by ADR 0006_: they are composition in `apps/server`, not infra; infra keeps only the binding-to-port adapters.
- If a client ever needs to install or build without core, the execution modules move to a `server` package as a mechanical extraction; the contract graph is already closed, so nothing else changes.
