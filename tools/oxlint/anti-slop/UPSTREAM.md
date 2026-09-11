# Vendored from dmmulroy/anti-slop

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10), copied from
  the bundled skill assets `skills/install-anti-slop/assets/anti-slop` (the
  upstream `src/` without its `*.test.ts` files).
- Installed: `tools/oxlint/anti-slop/index.ts` (generic rules) and
  `tools/oxlint/anti-slop/effect/index.ts` (Effect rules), registered in
  `vite.config.ts` under `lint.jsPlugins`; `@oxlint/plugins` is pinned in the
  workspace catalog to the `oxlint` version Vite Plus resolves.
- Deviations: none yet. Edit the rules here when the team's standard differs;
  record the change in this file so a later upstream merge can be three-way.

## Deviations

- 2026-09-11: every rule is registered at `warn`, not `error`. The existing
  code produced 1750 findings when the rules landed and the team chose to
  keep `vp check` green and clean up ticket by ticket. Flip a rule to
  `error` in `vite.config.ts` once its findings reach zero.
