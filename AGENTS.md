# Digital Shelf

A scrape management system for a digital shelf, built on Effect v4 and Cloudflare. Brands, Products, Variants, Retailers, Listings and Pages are configured so Scrapes and Extractions can run against them on a cadence.

## Structure

- `packages/domain`: schemas, ids, states and error codes shared by every package.
- `packages/core`: business logic. `<Area>/repositories/*Repo.ts` are query functions over `Sql/Db`; `<Area>/<Feature>.ts` are services owning transactions and rules; `Layers.ts` composes features per entrypoint. Test adapters live in `core/test/layers/` (ADR 0003).
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

## Conventions

- Use Effect for schemas, services, errors, configuration and side effects.
- Use Vite Plus (`vp`) for checking, testing and builds; tests use `@effect/vitest`.
- Drive Drizzle Kit through the `db:*` scripts in `packages/infra/package.json` (`pnpm db:generate`, and `db:migrate` once it lands), and commit only what they generate: `migration.sql` and `snapshot.json` are never written or edited by hand. Until the first production deploy, a schema change deletes `packages/infra/src/Sql/migrations` and regenerates the initial migration.
- Prefer tagged unions that make invalid states unrepresentable.
- Make the smallest correct change and follow existing repository patterns.

## Verification

Run `vp check` and `vp test --run` for every affected workspace package.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues; the wayfinder map is issue #1. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root is the glossary, ADRs go in `docs/adr/`. See `docs/agents/domain.md`.
