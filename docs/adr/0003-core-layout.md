# Core is features over function repositories, wired per entrypoint

`packages/core` has three kinds of module, and they nest one way. **Repositories** (`<Area>/repositories/<Entity>Repo.ts`) are plain functions over the `Db` tag: one query each, decoded into the domain entity, failing with `SqlError` or the entity's not-found error, never opening a transaction. **Features** (`<Area>/<Feature>.ts`) are `Context.Service` classes whose `make` reads the tags it needs once and exposes command and query methods; a feature owns its transaction, its cross-repository logic (cascade counting, effective pause, cadence maths) and its spans. **Layers** (`Layers.ts`) compose features per entrypoint (API, cron, queue consumer) over a `Db` provided by infra, so each Worker carries only the features it serves. Test adapters (a PGlite-backed `Db`, `reset`, and a PostgreSQL-backed `Db` for the few tests that need two transactions open at once) live in `packages/core/test/layers/`, outside `src`, so shipped code never imports them.

We chose function repositories over `Context.Service` repositories because nothing varies across that seam: there is one Postgres, and tests run the real queries on PGlite. A service tag would be a hypothetical seam paid for on every call site. Features are services because their callers (API handlers, cron, MCP) do vary and are wired differently per Worker.

## Considered options

- **Repositories as services with in-memory fakes.** Rejected: the fakes would restate the queries' semantics (ordering, uniqueness, cascade) and drift from them. PGlite runs the real thing in milliseconds.
- **One `Db` tag per driver (`PgDb`, `PgliteDb`).** Rejected: both Drizzle drivers produce the same `PgEffectDatabase` type, and `withTransaction` routes the reserved connection through fiber services, so one tag serves both and repository queries join whichever transaction the calling feature opened.
- **Transactions inside repositories.** Rejected: a repository that opens its own transaction cannot take part in the feature's, so a cascade delete would split across several. Repositories stay transaction-free; `Boundaries.test.ts` enforces it.

## Consequences

- A repository never imports a feature, `Sql/` knows no feature, and `src/` never imports `test/`, `infra` or `api`. The boundaries test is the source of truth for the rule set.
- Drizzle's query failures are unwrapped into `SqlError` at the repository seam (`Sql/Errors.ts`), so features match on `reason` (`UniqueViolation` by constraint name) rather than on Drizzle's wrapper.
- Rows are decoded explicitly through the domain schemas (`Sql/Rows.ts`); a row that fails to decode is a defect, not an error, because the table is the entity's definition (ADR 0002).
- pnpm instances Drizzle per peer set, so the root `package.json` carries Drizzle's peer packages (`@electric-sql/pglite`, `@effect/sql-pglite`, `@effect/sql-pg`, and later `pg`) as devDependencies to keep one `drizzle-orm` instance across domain, core and infra.
