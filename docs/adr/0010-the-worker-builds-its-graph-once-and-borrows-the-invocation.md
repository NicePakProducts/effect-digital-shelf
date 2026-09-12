# The Worker builds its graph once and borrows the invocation

A request to the API used to cost half a second before its handler ran. The Worker rebuilt the whole Effect layer graph per invocation, and three of those layers did I/O while they were built: the Postgres client proved its pool with a `SELECT 1`, Better Auth seeded its OAuth resource, and the telemetry exporters flushed to Axiom when the request scope closed, which Effect's HTTP pipeline does before the response leaves. Rebuilding the graph itself costs a few milliseconds; the round trips did the damage, and from Melbourne each one to the database in us-east is two hundred milliseconds.

The Worker now builds once per isolate and borrows what belongs to the invocation:

- **The graph is built at init.** `HttpRouter.toHttpEffect` runs in the Worker's init effect, as does the Cron feature, so features, repositories, the router and Better Auth exist once per isolate. The Workflow steps keep building their layers per step, since a step is its own invocation.
- **The database connection belongs to the invocation.** `Db` is Alchemy's `Drizzle.Postgres` over the Hyperdrive connection string. Alchemy memoises the client on the invocation's scope: the first statement opens the pool, closing the scope ends it, and a socket never outlives the request that opened it, which is the one connection lifecycle workerd allows. Repositories still take `Db` at build (ADR 0008); the tag holds one value for the isolate.
- **Better Auth runs adapter calls in the invocation's context.** Its adapter runs queries on its own promise chains, outside any Effect fiber, so the context it captured at construction would key every connection on the isolate. `Auth` wraps each call into Better Auth in Better Auth's own per-request state and the adapter merges that context over the captured one. Better Auth is instantiated on first use, so an invocation that never authenticates never reaches the database, and its OAuth seed runs once per isolate.
- **Session checks read a signed cookie.** Better Auth's cookie cache answers `getSession` without a query for five minutes; a revoked session can outlive its row by that long.
- **Telemetry is registered with Alchemy.** The Axiom exporters are handed to Alchemy's `Telemetry.layer` at init. The runtime bridge builds them into every event's scope, yields one task so the request span reaches the buffer, and closes that scope through `ctx.waitUntil`, so no response waits on Axiom (ADR 0007). Health probes are excluded from tracing.
- **The Worker runs where the database is.** Placement pins the Worker to AWS us-east-1 beside the Hyperdrive pool, so a request pays one long hop from the client instead of one per query. Smart Placement was tried first and never activated on dev's traffic.

## Considered options

- **Keep the per-invocation graph and make its layers lazy.** Done first, and it removed the connect and the seed for ping. Rejected as the end state: every authenticated request still paid the seed and the router build, and the telemetry flush stayed on the response path.
- **A request-scoped connection through a `Context.Reference` and `PgClient.makeWith`.** Effect's supported seam for a custom acquirer, and the shape Alchemy's memo implements. Rejected because Alchemy already ships that mechanism for Workers; owning a second copy of it buys nothing.
- **Carry the invocation into Better Auth with our own `AsyncLocalStorage`.** Rejected: it drags Node's types into core, and Better Auth exposes `runWithRequestState` and `defineRequestState` for exactly this.
- **Own the telemetry scope and close it through `waitUntil` ourselves.** Done briefly. Rejected once Alchemy's `Telemetry.layer` was found to do the same with the macrotask yield the root span needs.
- **Move the database to an Australian region.** The largest gain for Australian clients, since every round trip becomes local. Deferred: it is a data migration, not a composition change, and the placement pin captures most of the benefit for multi-query requests.

## Consequences

- ADR 0006's adapter rule is amended: an adapter may run Alchemy's `Drizzle` and `SQL` helpers, which are Effect utilities for the invocation's connection lifecycle and name no Cloudflare resource; imports of Alchemy resources stay type-only, and `packages/infra/test/Boundaries.test.ts` enforces both.
- Layers do no I/O at construction. A layer that must reach a binding or a socket resolves it per invocation, through Alchemy's execution memo or a `Context.Reference`, never through a value captured at build.
- Alchemy's Postgres client still runs `SELECT 1` when an invocation first touches the database, one round trip per database-touching invocation that placement makes negligible. Making that pool lazy is an upstream change.
- `getSession` on a cookie miss is two sequential queries, session then user, because the adapter does not implement Better Auth's `join`; implementing it would make it one.
- Configuration failures surface at Worker init rather than per request: a `ConfigError` fails the isolate once, where Alchemy logs it and the deploy smoke catches it.
- The Alchemy request scope closes in `ctx.waitUntil`, so anything attached to it, including the database pool of an invocation, finishes after the response.
- Per-route server time on the dev stage is the acceptance check: a route that never touches the database answers at the network floor, and a database route pays the round trips its queries need and nothing else.
