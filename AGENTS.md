# Digital Shelf

A scrape management system for a digital shelf, built on Effect v4 and Cloudflare. Brands, Products, Variants, Retailers, Listings and Pages are configured so Scrapes and Extractions can run against them on a cadence.

## Structure

- `packages/domain`: schemas, ids, states and error codes shared by every package.
- `packages/core`: business logic. `<Area>/repositories/*Repo.ts` are `Context.Service` classes over `Sql/Db`, one query per method, never opening a transaction, provided by the feature that uses them; `<Area>/<Feature>.ts` are services owning transactions and rules, exposing `layer` (and `layerNoDeps` only where a second assembly exists); `Layers.ts` composes features per entrypoint (ADR 0003, ADR 0008). Test adapters live in `core/test/layers/` (ADR 0003).
- `packages/api`: typed Effect HttpApi contracts and the handlers that implement them over `core`; contract modules (`*Api.ts`, `*Wire.ts`, `RootApi.ts`, `<Area>/Errors.ts`, `Auth/Security.ts`) never reach core, execution modules (`*Handlers.ts`, `Auth/CurrentUserMiddleware.ts`, `Auth/AuthRoutes.ts`, `Api.ts`) do (ADR 0005).
- `packages/infra`: Alchemy resource declarations under `Resources/`, adapters under `Adapters/` that satisfy core's tags (`Db`, `Storage/R2Bucket`, `Scheduling/Executions`) from Cloudflare binding values, and the committed migrations (ADR 0006).
- `apps/server`: the composition root, one Worker hosting the API, Better Auth, the cron and the Scrape and Extraction Workflows over core's layers and infra's adapters; `alchemy.run.ts` at the root imports it (ADR 0006).
- `.repos/`: read-only reference snapshots (slopcop for layout and toolchain, the Effect RC source). Read `.repos/README.md` before using them.

## Boundaries

- Put types and schemas shared across packages in `packages/domain`.
- Put HTTP contracts and their handlers in `packages/api`; put behaviour in `packages/core`. Clients import only api's contract modules.
- Keep deployment resources and platform adapters in `packages/infra`; keep Worker and Workflow composition in `apps/server`, which holds no rules.
- Depend inward: `apps/*` on `api`, `core`, `infra` and `domain`; `api` on `core` and `domain`; `infra` on `core` and `domain`, never on `api` or an app; `core` on `domain`; `domain` on nothing but Effect and Drizzle's schema builders. Drizzle tables live only in `packages/domain/src/Sql/`; entity schemas are derived from them (ADR 0002).
- Inside `core`, repositories import only domain, Drizzle, Effect and `Sql/`, and never open transactions; `packages/core/test/Boundaries.test.ts` enforces this.
- Inside `core`, a feature's public method type never carries a `*Repo` in `R`: a feature yields its repos once in `make` and provides them in its own `layer` (ADR 0008); a shared private helper that needs a repository is itself a service the feature yields and provides (ADR 0009); public peers such as `Cascade` stay composed in `Layers.ts`.

## Conventions

- Use Effect for schemas, services, errors, configuration and side effects.
- Use Vite Plus (`vp`) for checking, testing and builds; tests use `@effect/vitest`.
- Drive Drizzle Kit through the `db:*` scripts in `packages/infra/package.json` (`pnpm --filter @digital-shelf/infra db:generate --name <change>` and `pnpm db:migrate` over the direct `DATABASE_URL`), and commit only what they generate: `migration.sql` and `snapshot.json` are never written or edited by hand. Migrations are append-only: preserve the initial migration and generate a new migration for each schema change.
- Reach `@cloudflare/playwright` only through the dynamic `import()` in `packages/core/src/Providers/Playwright.ts`; a static import anywhere in a Worker or Workflow's init graph breaks `alchemy deploy`, which evaluates those modules in Node (#18).
- Prefer tagged unions that make invalid states unrepresentable.
- Feature public methods take one named input object whenever they carry an id or data, a single id included (`brands.get({ brandId })`, `brands.update({ brandId, command })`); a parameterless `list`, a `list` over one filter object and a `create` over one command struct stay as they are. Each operation-input wrapper is its own `Schema.Struct` named `<Operation>Input`, never an alias of another operation's, in `packages/domain` beside the commands, which keep their names (ADR 0008). Repositories stay positional (`repo.get(id)`).
- Shared private helpers that need a repository or a client are a `Context.Service` each consumer yields in `make` and provides in its own `layer`, never a service value passed as a parameter (ADR 0009); public peers such as `Cascade` remain composed in `Layers.ts` (ADR 0008).
- Guard with `Predicate.isError`, never `instanceof Error`.
- Read time through `DateTime.now` or `Clock` wherever an Effect seam exists; Drizzle column defaults (`defaultNow()`, `$onUpdate`) stay as they are.
- `orDie` only where a failure can only be a bug, marked with a `SAFETY:` comment: row decoding in `Sql/Rows.ts` and the decoding of Workflow parameters this codebase encoded in `apps/server`. Configuration and provider setup failures stay in the layer's `E`; operational provider failures stay in the method's `E` (ADR 0008).
- Make the smallest correct change and follow existing repository patterns.

## Code style

- Bind a service to a named variable before calling its methods: `const brands = yield* Brands`, then `yield* brands.get(...)`; never `yield* (yield* Brands).get(...)`.
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

Run `vp check` and `vp test --run` for every affected workspace package.

Repositories are never faked: a core test builds a feature over the real `Db` (PGlite by default) and reaches a `*Repo` only through its real `.layer`. A rule in `packages/core/test/Boundaries.test.ts` rejects the direct substitution forms listed in ADR 0008; review checks aliases and indirect constructions.

`.github/workflows/ci.yml` runs exactly those commands for every package on
every pull request, and nothing else: it never deploys and never touches a
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
