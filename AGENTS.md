# Digital Shelf

A scrape management system for a digital shelf, built on Effect v4 and Cloudflare. Brands, Products, Variants, Retailers, Listings and Pages are configured so Scrapes and Extractions can run against them on a cadence.

## Structure and boundaries

- `packages/schema`: flat singular transport-neutral Effect data schemas and ids; depends only on Effect. Entity codecs are explicit; db's `SchemaParity.test.ts` checks them against the tables and committed migrations.
- `packages/db`: the driver-independent `Db` contract (root export), invocation-aware adapter (`/adapter`), Drizzle tables (`/schema/*`), registry, configuration and append-only migrations. No core dependency, including devDependencies.
- `packages/core`: public capabilities (`products.ts`, `products/variants.ts`) and feature-owned private `repository.ts` modules. Features own business errors, rules and transactions; repositories capture Db once, decode rows, and never open transactions. Test adapters live in `core/test/layers/`.
- `packages/protocol`: flat resource HttpApi contracts, independent HTTP error schemas/status annotations, auth declarations and wire projections; imports schema and Effect only.
- `packages/client`: generated HttpApiClient, reactive binding and browser auth SDK seam; imports protocol/schema, never core/db/server. `apps/web` imports client/schema only.
- `packages/infra`: Alchemy resources and non-DB platform adapters; depends on core/db/schema, never HTTP packages or apps. The cross-resource InstantDB→Postgres/R2 importer stays in `infra/scripts`.
- `apps/server` (`@app/server`): app-local handlers/auth mounts and `http.ts` assembly over public core capabilities. `Worker.ts` owns the application Layer graph and directly default-exports the one Cloudflare Worker hosting HTTP, Better Auth, cron and both Workflows. Root `alchemy.run.ts` imports it; business rules stay in core.
- `.repos/`: read-only reference snapshots. Read `.repos/README.md` before using them.

For package ownership, error translation or layer assembly changes, read ADR 0012, which supersedes ADR 0011's placement/naming/error choices. For joined-read ownership, also read ADR 0011's narrow SQL exceptions. Earlier decisions remain historical; ADR 0010's isolate/invocation lifetime still applies.

Public exports are explicit source paths, never wildcard repository exposure. Cross-feature callers use public capabilities; Products and ProductVariants share one persistence boundary. Core's boundary tests enumerate exact repository consumers and read/write table sets, including narrow joined-read and Cascade exceptions; directory proximity grants no access. `PackageBoundaries.test.ts` resolves workspace imports, relative paths, re-exports, literal dynamic imports and TS paths. Review also checks indirect constructions and aliased SQL writes.

## Conventions

- Use Effect for schemas, services, errors, configuration and side effects.
- Every workspace uses a unique `@app/*` name. Core has named capability files and no `index.ts`; shared models use singular namespaces (`Product.Info`, `ProductVariant.Create`); database symbols end in `Table` without changing SQL names.
- Handlers directly export descriptive `*HandlersLayer` values and explicitly construct protocol errors from core errors. Named composition/test values use PascalCase `*Layer`; core public `layer` / `layerNoDeps` remain stable. Compose directly with `Layer.mergeAll` / `Layer.provide`.
- Public capabilities expose a named namespace, `Interface`, `Service`, stable `layerNoDeps` and stable default `layer`; defaults provide private helpers/repositories and public peers. Ports have no invented default implementation. Feature method environments are closed; no private repository escapes in `R`. Shared dependency-bearing private helpers are services, not service values passed as parameters.
- One Db adapter layer value supplies a combined graph. Stable layer identity shares services inside its memo map, never across independent builds. Alternate `layerNoDeps` tests still provide real repository layers; repository substitution in the E12 reference is intentionally replaced by real-persistence tests.
- Use Bun for dependency installation and workspace scripts (`bun install --frozen-lockfile`, `bun run --filter <package> <script>`); commit `bun.lock`. Use Vite Plus (`vp`) for checking, testing and builds; tests use `@effect/vitest`.
- Drive Drizzle Kit through the `db:*` scripts in `packages/db/package.json` (`bun run --filter @app/db db:generate --name <change>` and `bun run db:migrate` over the direct `DATABASE_URL`), and commit only what they generate: `migration.sql` and `snapshot.json` are never written or edited by hand. Migrations are append-only: preserve the initial migration and generate a new migration for each schema change.
- Reach `@cloudflare/playwright` only through the dynamic `import()` in `packages/core/src/scrapes/providers/playwright.ts`; a static import anywhere in a Worker or Workflow's init graph breaks `alchemy deploy`, which evaluates those modules in Node (#18).
- Prefer tagged unions that make invalid states unrepresentable.
- Feature public methods take one named input object whenever they carry an id or data, a single id included (`brands.get({ brandId })`, `brands.update({ brandId, command })`); a parameterless `list`, a `list` over one filter object and a `create` over one command struct stay as they are. Each operation-input wrapper is its own `Schema.Struct` named `<Operation>Input`, never an alias of another operation's, in `packages/schema` beside the commands in each model namespace (ADR 0012). Repositories stay positional (`repo.get(id)`).
- Shared private helpers that need a repository or a client are a `Context.Service` each consumer yields in `make` and provides in its own `layer`, never a service value passed as a parameter (ADR 0009); default feature layers also provide their public peers; Worker composition merges the defaults (ADR 0012).
- Guard with `Predicate.isError`, never `instanceof Error`.
- Read time through `DateTime.now` or `Clock` wherever an Effect seam exists; Drizzle column defaults (`defaultNow()`, `$onUpdate`) stay as they are.
- `orDie` only where a failure can only be a bug, marked with a `SAFETY:` comment: row decoding in `Sql/Rows.ts` and the decoding of Workflow parameters this codebase encoded in `apps/server`; plus one boundary, the Workflow step body in `apps/server/src/WorkflowSupport.ts`, where Alchemy's `Workflows.task` takes `E = never` and the step's retry configuration is the handler (ADR 0008). Configuration and provider setup failures stay in the layer's `E`; operational provider failures stay in the method's `E`. At Worker init only, Alchemy requires `E = never`, so configuration failure aborts initialization once. HTTP operational failures use safe diagnostics and an empty 500, not defects (ADR 0012).
- The Worker builds its layer graph once per isolate and borrows what belongs to the invocation (ADR 0010): `Db` is the Effect Drizzle database over Alchemy's invocation-aware Postgres client, which memoises the connection on the invocation's scope; `Auth` runs every call into Better Auth inside Better Auth's request state so its adapter sees that scope; telemetry is registered through Alchemy's `Telemetry.layer`, which flushes through `ctx.waitUntil`. Layers do no I/O at construction, and nothing captured at build may hold a socket or a per-request service.
- Make the smallest correct change and follow existing repository patterns.

## Code style

- Bind a service to a named variable before calling its methods: `const brands = yield* Brands.Service`, then `yield* brands.get(...)`; never `yield* (yield* Brands.Service).get(...)`.
- Avoid `try/catch`; use `Effect.try`, `Effect.tryPromise` or a schema decode. A narrow `try/catch` is allowed only at a foreign API that throws (`jsonrepair`, the Better Auth field lookup).
- Avoid unnecessary destructuring; use dot access.
- `const` over `let`; ternaries or early returns over reassignment.
- No `else`; return early.
- A happy-path main function with small named helpers below it; helpers stay synchronous unless they are effectful.
- Parse JSON with `Schema.fromJsonString(Schema.Unknown)` and `Schema.decodeUnknownOption` (or the Effect decoder), never `JSON.parse` inside `Effect.try`. `Schema.UnknownFromJsonString` is `@internal` on the pinned RC; do not use it.
- Comments only for non-obvious constraints.
- Tests avoid mocks and `globalThis.*` and test the real implementation.
- `prefer-const`, `no-else-return` and `no-lonely-if` are enforced by `vp lint` at `error`.

## Verification

Run `vp check` and `vp test --run --maxWorkers=2 --no-file-parallelism` serially for every affected workspace package. PostgreSQL suites rebuild public schema; never run those files concurrently. Also run root `bun run check`, `bun run check:types` and the web build when package contracts change. Report nonzero declaration-build exits even when the patched Effect compiler emits only warnings/suggestions.

Repositories are never faked: a core test builds a feature over the real `Db` (PGlite by default) and reaches a `*Repo` only through its real `.layer`. A rule in `packages/core/test/Boundaries.test.ts` rejects the direct substitution forms listed in ADR 0008; review checks aliases and indirect constructions.

`.github/workflows/ci.yml` runs root/workspace checks, serial tests and the web build on
every pull request: it never deploys and never touches a
project database. It also starts a disposable PostgreSQL service, because
PGlite runs one connection in-process and so cannot overlap two transactions.
A test that needs a real server reads the DSN from
`DIGITAL_SHELF_TEST_POSTGRES_URL` and may skip itself when it is unset, so a
local run without Postgres stays green; a skipped test is never the proof, so
CI always sets it and `.github/scripts/postgres-lock-probe.sh` fails the job
if the service is not really there. Never point that variable at a dev or
production database.

## Agent skills

For local development, migrations, deployment or deploy smokes, read `docs/agents/deploy.md`.

### Issue tracker

Issues live in this repo's GitHub Issues; the wayfinder map is issue #1. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root is the glossary, ADRs go in `docs/adr/`. See `docs/agents/domain.md`.
