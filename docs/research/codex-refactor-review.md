# Codex adversarial and evidence review of the locked refactor design

Research for [#69](https://github.com/NicePakProducts/effect-digital-shelf/issues/69), against the
standing decisions 1 to 14 on map [#68](https://github.com/NicePakProducts/effect-digital-shelf/issues/68).
Reviewer: Codex `gpt-6-astra`, read-only sandbox, run from the repo root with the brief on stdin
(two passes in one run: adversarial, then a numbered evidence pass). Every citation below was
produced by the reviewer against the checkout at `1dbd2f5`; the spot-check section records where a
second reading of the cited lines agreed or disagreed.

Pinned versions at the time of review: `effect@4.0.0-rc.112` (`pnpm-workspace.yaml:9`, and the same
version in `.repos/effect/packages/effect/package.json`), `drizzle-orm@1.0.0-rc.5-ab785fc`,
`oxlint@1.81.0` through `vite-plus@0.3.1`.

## Ranked changes Codex would make before the ADR

Ranked by expected damage if not fixed. The disposition column is this session's call, argued in
the resolution comment on #69.

| # | Amends | Change | Disposition |
|---|---|---|---|
| 1 | D1, D2, D8, D9 | State the client/lifetime invariant explicitly: one SQL client per invocation for cooperating features and repos, stable layer references, isolated builds per binding set. Make the proving PR exercise a repo constructed *before* the transaction opens, a rollback after a real write, and invocation isolation. | Fold into ADR |
| 2 | D2 | Require closed method environments. Providing repo layers to a feature's layer satisfies the *layer's* requirements, not the requirements of effects the feature's methods return, nor of module-level helpers. Capture repo instances in `make` and pass them into helpers such as `packages/core/src/Scraping/Transitions.ts`. Check public-method `R` separately from layer `R`. | Fold into ADR |
| 3 | D5 | The stated vocabulary is wrong: repo-local `DomainTaken`, `PageTaken` and the domain's `DuplicateVariantName` already exist. Reword to "preserve the existing errors; introduce no new generic per-repo wrappers." | Fold into ADR |
| 4 | D7 | Complete the `orDie` inventory. Auth request failures, generated-id decoding, extraction projection decoding and metadata encoding fall outside the two named exceptions; classify each site and say how a typed layer failure is handled at the HTTP, cron and Workflow boundaries. A `SAFETY:` comment supplies no handling. | Fold into ADR (inventory belongs to the area tickets) |
| 5 | D12, D13, D14 | Add a merge barrier and an ownership inventory, so a rule promoted mid-flight does not break open worktree branches and no violation is left unowned. | Partly rejected: the repo has **zero** violations of the three rules today, so there is nothing to own and no barrier to build; the two-step promotion itself is what should go |
| 6 | D9 | Specify a bounded checker. Aliases, re-exports, `Context.make`, helper-produced layers and reused instances defeat name matching, and a literal syntactic ban rejects legitimate `Repo.layer.pipe(...)` compositions. | Fold into ADR, as an explicit scope statement on the rule |
| 7 | D3, D4 | Make one layer the default. `layerNoDeps` is dead weight wherever nothing alternate is ever assembled (an adapter with no internal `Layer.provide`, a feature whose only internal deps are mandatory real repos). Expose the pair only where a second assembly exists. Also: the D3 split is defensible as *private persistence vs public peer feature*, but "carries `Db` and `R2Bucket` and has tests" does not establish it — record the role-based rule instead. | Fold into ADR |
| 8 | D6, D10, D11 | Narrow the mechanical rewrite contract: named domain inputs only for data-bearing multi-argument operations (not for re-wrapping an existing command object, not for a parameterless `list`), keep narrow `try/catch` at throwing foreign APIs (`jsonrepair`, the Better Auth field lookup), and use the public `Schema.fromJsonString(Schema.Unknown)` because `Schema.UnknownFromJsonString` is `@internal`. | Fold into ADR |

Codex also ran three direct probes against the pinned RC, reported in its adversarial pass:

- Six consumers of one repo layer constructed it once; a **separate build** constructed it again.
- Two branches supplying **different** `Db` values to the same repo layer both received the first
  captured value: the memo key is the layer reference, dependencies are not part of the key.
- Providing a dependency to a feature's layer did **not** supply it to an unbound effect returned
  by a feature method; that method failed with `Service not found`.

## Evidence pass

`effect/…` paths are under `.repos/effect/packages/effect/src/`. T1 to T5 are the five claims the
ticket singled out; the rest are the factual claims inside decisions 1 to 14. Codex noted that D13
and D14 are sequencing policy, not independently verifiable runtime facts.

| # | Claim | Verdict | Citation | Note |
|---|---|---|---|---|
| T1 | Capturing `Db` at construction does not prevent joining the caller's transaction | VERIFIED | `drizzle-orm/effect-postgres/session.js:25`; `effect/unstable/sql/SqlClient.ts:142`; `SqlClient.ts:265` | Requires the *same* underlying client. What rides the fiber is the transaction connection, not a replacement `Db` |
| T2 | The RC memoizes a layer by reference inside one build, so six features sharing a repo layer construct it once | VERIFIED | `effect/Layer.ts:432`; `Layer.ts:451` | Identity-keyed map; concurrent consumers await the shared entry. Conditional on one memo map and live scopes |
| T3 | `Layer.provide([a, b])` array form exists on the pinned RC | VERIFIED | `effect/Layer.ts:1436`; `Layer.ts:1341` | Non-empty-array overload and implementation both present; providers merge concurrently |
| T4 | slopcop's `LabelingRules` uses the `layerNoDeps` + `layer` pair being copied | VERIFIED | `.repos/slopcop/packages/labeling/src/LabelingRules.ts:705` | Exact pair; `GitHubClient.layer` is provided internally at line 709 |
| T5 | oxlint ships `prefer-const`, `no-else-return`, `no-lonely-if` and Vite Plus can enable them | VERIFIED | `oxlint/configuration_schema.json:6122`, `:4642`, `:5001`; `vite-plus/dist/define-config-DPNEJxPz.d.ts:177` | All three in the schema, the types and the native binary; `lint.rules` takes an `OxlintConfig`, so the names are unprefixed |
| 1 | Repo and reference source are both Effect rc.112 | VERIFIED | `pnpm-workspace.yaml:9`; `.repos/effect/packages/effect/package.json:4` | |
| 2 | `Context.Service` supports a class declaration with an effectful `make` | VERIFIED | `effect/Context.ts:209`; `Context.ts:258` | `make` is stored; declaring the class does not run it |
| 3 | `Layer.effect(this, this.make)` is supported and memoizes construction | VERIFIED | `effect/Layer.ts:1018`; `Layer.ts:1075` | Delegates to `effectContext`, then `fromBuildMemo` |
| 4 | slopcop's reference repo captures its SQL dependency once in `make` | VERIFIED | `.repos/slopcop/…/GitHubRepositoriesRepo.ts:48`, `:94`, `:338` | It captures `SqlClient.SqlClient`, not a Drizzle `Db` |
| 5 | The existing layout is function repositories over a Drizzle `Db` service | VERIFIED | `docs/adr/0003-core-layout.md:3`; `packages/core/src/Sql/Db.ts:30`; `packages/core/src/Catalog/repositories/BrandsRepo.ts:46` | |
| 6 | Providing repo layers removes their construction requirements and keeps upstream ones | VERIFIED | `effect/Layer.ts:1436` | `Success` is excluded from consumer `R`; provider `Services` and `Error` remain. Does **not** bind returned method effects |
| 7 | Outer `provide` compositions reuse the memo map for their dependencies | VERIFIED | `effect/Layer.ts:1339` | A new outer wrapper does not defeat sharing of the same inner repo layer |
| 8 | `Brands` currently leaves `Cascade` in its construction requirements | VERIFIED | `packages/core/src/Catalog/Brands.ts:44`, `:85` | |
| 9 | Catalog provides `Cascade` once with `provideMerge` today | VERIFIED | `packages/core/src/Layers.ts:29` | The file is `packages/core/src/Layers.ts`, not `Catalog/Layers.ts` |
| 10 | `provideMerge` supplies a dependency and retains its services | VERIFIED | `effect/Layer.ts:1553`; `Layer.ts:1584` | |
| 11 | `Cascade` captures `Db` and `R2Bucket` and is public | VERIFIED | `packages/core/src/Catalog/Cascade.ts:15`, `:63` | |
| 12 | `Cascade` has its own tests | VERIFIED | `packages/core/test/Catalog/Cascade.test.ts:118`, `:225` | Rollback and storage cleanup |
| 13 | SQL failures carry a `SqlError.reason` vocabulary | VERIFIED | `effect/unstable/sql/SqlError.ts:387`; `packages/core/src/Sql/Errors.ts:19` | |
| 14 | The repo error vocabulary is only `SqlError` plus the entity `NotFound`; no per-repo error classes | **WRONG** | `packages/core/src/Catalog/repositories/RetailersRepo.ts:25`; `PagesRepo.ts:36`; `VariantsRepo.ts:94` | Repo-local `DomainTaken` and `PageTaken` already exist, plus domain `DuplicateVariantName` |
| 15 | Existing repo lookups and updates are positional | VERIFIED | `…/BrandsRepo.ts:56`, `:83` | Inserts and filters already take records |
| 16 | Command schemas live in `packages/domain` | VERIFIED | `packages/domain/src/Catalog/BrandManagement.ts:6` | Operation-input schemas are future work |
| 17 | Config failures can stay typed layer failures | VERIFIED | `effect/Config.ts:108`; `Layer.ts:1018` | |
| 18 | Feature and provider config sites use `orDie` today | VERIFIED | `packages/core/src/Scraping/Extractions.ts:62`; `packages/core/src/Providers/ScrapeProviders.ts:196` | That provider layer declares `never` errors at line 258 |
| 19 | `orDie` turns typed failures into defects | VERIFIED | `effect/internal/effect.ts:3289` | `catch_(self, die)` |
| 20 | Row decoding and Workflow-step glue are defects today | VERIFIED | `packages/core/src/Sql/Rows.ts:40`; `apps/server/src/WorkflowSupport.ts:38` | The `SAFETY:` comments D7 asks for are not there yet |
| 21 | ADR 0006 specifies per-request / per-Workflow-step composition | VERIFIED | `docs/adr/0006-apps-are-composition-roots-infra-implements-core-ports.md:3`; `apps/server/src/ScrapeWorkflow.ts:31` | |
| 22 | Worker composition defers binding-dependent `Db` construction | VERIFIED | `apps/server/src/Worker.ts:93`; `packages/infra/src/Adapters/Db.ts:8` | |
| 23 | "Construct once" is bounded by the memo map | VERIFIED | `effect/Layer.ts:585`, `:699`, `:2160` | `build` creates or forks a memo map; `fresh` makes a new one. D2 and D3 do not establish process-wide sharing |
| 24 | PGlite is the default core test database | VERIFIED | `packages/core/test/layers/Db.ts:23`; `test/layers/Core.ts:22` | |
| 25 | Postgres is reserved for overlapping-transaction tests | VERIFIED | `packages/core/test/layers/Postgres.ts:17`; `test/Catalog/HostRule.postgres.test.ts:105` | |
| 26 | PGlite serialises transactions on one connection | VERIFIED | `.repos/effect/packages/sql/pglite/src/PgliteClient.ts:201` | One connection, one permit held to scope finalisation |
| 27 | Existing tests exercise real repositories over the database adapters | VERIFIED | `packages/core/test/Catalog/Brands.test.ts:52`; `test/layers/Core.ts:11` | Scripted fakes occupy the platform ports only |
| 28 | The proposed Boundaries rule can establish real-layer provenance | **UNVERIFIABLE** | `packages/core/test/Boundaries.test.ts:11`, `:24` | Not implemented. Settling it needs a defined supported syntax plus adversarial alias / re-export / helper cases |
| 29 | `Predicate.isError` gives the proposed guard | VERIFIED | `effect/Predicate.ts:1208` | Literally `input instanceof Error`; no cross-realm gain |
| 30 | `DateTime.now` reads Effect's clock | VERIFIED | `effect/internal/dateTime.ts:313` | `nowAsDate` too, line 316 |
| 31 | Drizzle has native current-time hooks to keep | VERIFIED | `packages/domain/src/Sql/Columns.ts:25` | SQL `defaultNow()` **and** a JavaScript `$onUpdate(() => new Date())` |
| 32 | `Layer.succeed` can hand over an already available binding | VERIFIED | `effect/Layer.ts:807`; `apps/server/src/Worker.ts:103` | |
| 33 | `Schema.UnknownFromJsonString` exists on this RC | VERIFIED | `effect/Schema.ts:12800` | Marked `@internal`; the public `fromJsonString` is at line 12789 |
| 34 | `Schema.decodeUnknownOption` gives synchronous optional decoding | VERIFIED | `effect/Schema.ts:1694` | Discards error detail and is not a universal exception catcher |
| 35 | Rules are registered through `lint.rules` in `vite.config.ts` | VERIFIED | `vite.config.ts:26` | The three style rules are not registered yet |
| 36 | oxlint accepts warn and error severities | VERIFIED | `oxlint/configuration_schema.json:513` | `warn` does not fail the exit code; `error` does |
| 37 | The anti-slop rollout went warn, then error | VERIFIED | `vite.config.ts@daf03d2:37`; `vite.config.ts@1dbd2f5:37` | #62 then #67 |

## Spot-check notes

Read independently against the same checkout; agreements are stated only where the claim is load-bearing.

- **T1 agreed, with a sharper mechanism.** `effect-postgres/session.js:23-30` shows `transaction()`
  delegating to `this.client.withTransaction(...)`. In `SqlClient.ts`, `makeWithTransaction`
  (line 224 onward) adds the reserved connection to the *effect's* services
  (`Context.add(options.transactionService, [conn, id])`), and `getConnection` (lines 143-149)
  resolves `Effect.serviceOption(transactionService)` at query time, falling back to the pooled
  acquirer. The decision's wording "rides on the fiber-local `SqlClient`" is imprecise: the client
  is a plain captured value, and what is fiber-scoped is a per-client `TransactionConnection` key
  minted at `SqlClient.make` time (`SqlClient.ts:142`, `clientIdCounter++`). The practical
  consequence is Codex's rank-1 change: **two `Db` values in one invocation means two keys, and a
  repo holding the wrong one silently runs outside the transaction with no type error.** The ADR
  should say this in one sentence.
- **T2 agreed.** `Layer.effect` → `effectContext` (`Layer.ts:1075`) → `fromBuildMemo`
  (`Layer.ts:380-388`), and `MemoMapImpl.map` is a `Map` keyed by the layer object
  (`Layer.ts:421-450`). `provideWith` (`Layer.ts:~1339`) threads the *same* memoMap into both the
  dependency build and the self build, so sibling features providing the same repo layer share it.
  The load-bearing precondition is that `Repo.layer` is a `static readonly` **field**, not a getter
  or a function: a getter returns a new object per access and every reference becomes its own memo
  key. The ADR should state that, since it is invisible at the call site.
- **T3 agreed**, `Layer.ts:1436-1444` is the array overload.
- **T4 agreed**, `LabelingRules.ts:705-715` verbatim. One thing neither the map nor Codex says:
  slopcop's `layerNoDeps` earns its keep because its **tests** build over it with substituted
  dependencies (`.repos/slopcop/packages/labeling/test/LabelingRules.test.ts:61`,
  `packages/github/test/GitHubClient.test.ts:42`, `apps/api/src/Worker.ts:30`). Decision 9 forbids
  faking repos, which removes the main consumer of the second layer here — independent support for
  Codex's rank-7 change.
- **T5 agreed, and verified empirically rather than only from the schema.** `vp lint <probe>.ts -W
  prefer-const -W no-else-return -W no-lonely-if` on a scratch file outside the tree reports all
  three as `eslint(...)` diagnostics, and `vite-plus/docs/config/lint.md:17` registers a bare
  `'no-console'` the same way, so unprefixed names work in `lint.rules`.
- **New finding, not in Codex's answer: the repo has zero violations of all three rules.** Running
  the same three rules over `packages` and `apps` returns nothing, while a control rule
  (`no-magic-numbers`) returns 751 diagnostics over the same paths, so the scan is real. The `let`
  bindings that exist (`Scraping/Sanitise.ts:5`, `Extractions.ts:115`, `ScrapeRunner.ts:76`, …) are
  all reassigned, and the `else` blocks (`ParentsRepo.ts:341`) do not follow a `return`. This makes
  D12's warn-then-error two-step and D13's "fix violations inside the area PR" ceremony over an
  empty set: the three rules can land at `error` in the ADR ticket, which also dissolves most of
  Codex's rank-5 merge-barrier concern.
- **Claim 14 confirmed WRONG.** `RetailersRepo.ts:25` and `PagesRepo.ts:36` each declare a
  repo-local `Data.TaggedError`, and `Retailers.ts:129` catches `DomainTaken` to re-raise the
  domain's `RetailerDomainTaken`. Decision 5 as written would mandate deleting a working pattern.
- **Codex's rank-2 change is real and bigger than its example.** `Scraping/Transitions.ts:71`
  (`transition`) calls `ScrapesRepo.*` at module level, so its `R` carries `Db` today and would
  carry `ScrapesRepo` after the refactor — a requirement the feature's `Layer.provide` does not
  discharge. Five modules import those helpers (`ScrapeRunner.ts:29`, `Extractions.ts:51`,
  `ExtractionRunner.ts:26`, `Scrapes.ts:39`, `Scheduling/Sweeps.ts:12`), so the ADR needs an
  explicit rule for cross-feature helpers, not just a note.
- **Disagreement with the map, which Codex did not raise.** ADR 0003 *rejected* `Context.Service`
  repositories on the record: "nothing varies across that seam … a service tag would be a
  hypothetical seam paid for on every call site"
  (`docs/adr/0003-core-layout.md`, paragraph 2 and the first considered option). Decision 1 reverses
  that, and none of the evidence above supplies a new seam — the honest justification is
  consistency with the slopcop shape and cheaper dependency capture, not testability. ADR 0008 must
  say what changed rather than re-argue the seam, or the two ADRs read as contradicting each other.
- **Scope note on Codex's probes.** Its "different `Db` values, first one wins" probe is correct
  about the memo key but needs both values inside one build to bite. Today each entrypoint builds
  one `Db` per invocation (`apps/server/src/Worker.ts:93`), so the live risk is a future test that
  composes two database layers in one build, which is exactly what the proving PR should cover.
