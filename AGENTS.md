# Digital Shelf

A scrape management system for a digital shelf, built on Effect v4 and Cloudflare. Brands, Products, Variants, Retailers, Listings and Pages are configured so Scrapes and Extractions can run against them on a cadence.

## Structure

- `packages/domain`: schemas, ids, states and error codes shared by every package.
- `packages/core`: business logic: repositories, catalog and lifecycle features, scheduling, providers.
- `packages/api`: typed Effect HttpApi contracts and transport errors.
- `packages/infra`: Alchemy resources, the D1 layer, migrations and bindings.
- `.repos/`: read-only reference snapshots (slopcop for layout and toolchain, the Effect RC source). Read `.repos/README.md` before using them.

## Boundaries

- Put types and schemas shared across packages in `packages/domain`.
- Put HTTP contracts and transport errors in `packages/api`; put behaviour in `packages/core`.
- Keep deployment resources and platform adapters in `packages/infra`.
- Depend inward: `core` and `api` on `domain`; `domain` on nothing but Effect.

## Conventions

- Use Effect for schemas, services, errors, configuration and side effects.
- Use Vite Plus (`vp`) for checking, testing and builds; tests use `@effect/vitest`.
- Prefer tagged unions that make invalid states unrepresentable.
- Make the smallest correct change and follow existing repository patterns.

## Verification

Run `vp check` and `vp test --run` for every affected workspace package.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues; the wayfinder map is issue #1. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root is the glossary, ADRs go in `docs/adr/`. See `docs/agents/domain.md`.
