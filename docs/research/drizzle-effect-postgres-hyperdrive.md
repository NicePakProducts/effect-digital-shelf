# Drizzle `effect-postgres` over Hyperdrive on Workers with PlanetScale (#25)

Research note for wayfinder ticket #25. Written 2026-09-09 against the versions
listed under "Working versions". Companion to
`docs/research/drizzle-effect-d1.md` (branch `research/drizzle-effect-d1`).

## TL;DR

- The stack `drizzle-orm/effect-postgres` → `@effect/sql-pg` → `pg` runs on
  workerd with `nodejs_compat` through a Hyperdrive binding. Verified locally
  with wrangler 4.130.0 (workerd 1.20260908.1) against a real PostgreSQL 18.4
  behind the Hyperdrive local passthrough: Drizzle transactions commit and roll
  back, `SqlClient.withTransaction` nests as a savepoint, a unique violation
  surfaces as `EffectDrizzleQueryError` wrapping `SqlError` with
  `reason._tag === "UniqueViolation"`. `pg` 8.23.0 (pulled in by
  `@effect/sql-pg`'s `pg ^8.23.0`) satisfies Hyperdrive's stated minimum
  (8.16.3 in the node-postgres guide; 8.13.0 in Get started).
- The smallest working layer is one `PgClient.layer({ url, maxConnections: 1 })`
  built **inside the handler** from `env.HYPERDRIVE.connectionString`, with
  `Layer.effect(Db, PgDrizzle.makeWithDefaults())` on top. Build it per
  request (or per Workflow step); never at module scope. Drizzle's
  `transaction` delegates to `SqlClient.withTransaction`, so both survive;
  the transaction pins one Hyperdrive origin connection for its duration.
- Hyperdrive query caching is on by default (`max_age` 60 s, `swr` 15 s) and
  caches any `SELECT` without volatile or `STABLE` functions, which includes
  every lifecycle read. Turn it off on the config the lifecycle uses:
  Alchemy `caching: { disabled: true }` → API `caching.disabled`; wrangler
  `--caching-disabled`. Drizzle's own Effect cache is a no-op by default.
- PlanetScale: point Hyperdrive at port **5432** (direct), not 6432 (PgBouncer;
  Hyperdrive already pools in transaction mode and PgBouncer only supports
  transaction mode). TLS is mandatory (`sslmode=verify-full`); Hyperdrive's
  default `require` works, `verify-full` needs the CA uploaded. Enums,
  `ALTER TYPE` and `jsonb` are plain Postgres on PlanetScale; the only DDL
  restriction is role-based (`pg_read_all_data`/`pg_write_all_data` roles
  cannot run DDL).
- Migrations: run the committed `migration.sql` files from CI over the direct
  5432 connection with a DDL-capable role, never through Hyperdrive. Two
  ready-made runners exist: Alchemy's `Planetscale.PostgresBranch({ migrations })`
  (temporary role, per-file `BEGIN`/`COMMIT`, bookkeeping in
  `__alchemy_migrations`) and Drizzle's `effect-postgres` migrator (single
  transaction, bookkeeping in `drizzle.__drizzle_migrations`). Pick one; their
  bookkeeping tables are not interchangeable.
- Alchemy 2.0.0-beta.76 has both halves: `Cloudflare.Hyperdrive.Connection`
  (origin, `caching`, `mtls`, `originConnectionLimit`, `dev`) and a PlanetScale
  provider (`Planetscale.PostgresDatabase`, `PostgresBranch`, `PostgresRole`,
  `PostgresDefaultRole`) whose `PostgresRole.origin` feeds Hyperdrive directly.
  Worked `alchemy.run.ts` in section (f).
- The "PlanetScale from the Cloudflare dashboard" change (changelog
  2026-06-18) is a **billing/account link plus dashboard convenience**, not a
  new Hyperdrive origin type. The database lives in your PlanetScale org; the
  Hyperdrive config it creates is an ordinary one. The only public API surface
  is `POST /accounts/{id}/hyperdrive/integrationsOperations/planetScale/createDatabaseSignature`
  (what `wrangler hyperdrive planetscale signature` calls, experimental),
  consumed by `pscale database create --cloudflare-billing`. Alchemy cannot
  express the link; use plain Hyperdrive-over-PlanetScale-credentials.
- **Outstanding:** the deployed transaction-and-rollback smoke through real
  Hyperdrive to PlanetScale did not run. No Cloudflare or PlanetScale
  credentials exist in this environment (see section (i)); the smoke Worker is
  written and typechecks, and is included below as the proposal.

## Sources

### Local

- `.repos/effect/packages/sql/pg/src/PgClient.ts` (effect 4.0.0-rc.112):
  `make`, `layer`, `fromPool`, `fromClient`, `makeClient`, error classification.
- `.repos/effect/packages/effect/src/unstable/sql/SqlClient.ts`: `make`,
  `withTransaction`, `reserve`, `TransactionConnection`, savepoint naming.
- `.repos/effect/packages/sql/pglite/src/PgliteClient.ts`.
- `node_modules/.pnpm/drizzle-orm@1.0.0-rc.5-ab785fc_*/node_modules/drizzle-orm/effect-postgres/{driver.d.ts,session.js,migrator.d.ts}`,
  `pg-core/effect/session.js`, `effect-core/defaults.js`,
  `cache/core/cache-effect.js` (Drizzle sources; also `effect-pglite/`).
- `alchemy@2.0.0-beta.76` tarball (`npm pack`), files under `src/`:
  `Cloudflare/Hyperdrive/{Connection,Connect,ConnectBinding,index}.ts`,
  `SQL/{ConnectionSource,PostgresDriver,Postgres}.ts`,
  `Drizzle/{Postgres,Cloudflare}.ts`,
  `Planetscale/Postgres/{PostgresDatabase,PostgresOrigin,PostgresMigrations,PostgresRole,PostgresDefaultRole,index}.ts`,
  `Planetscale/{Credentials,Database}.ts`,
  `SQL/Migrations/{index,PgExecutor,Detect}.ts`, `Runtime/ExecutionMemo.ts`,
  `package.json` (peers).
- `wrangler@4.130.0` `wrangler-dist/cli.js` (`src/hyperdrive/planetscale.ts`,
  `src/hyperdrive/client.ts` sections).
- Branch `feat/domain-package`: `pnpm-workspace.yaml` catalog,
  `packages/infra/drizzle.config.ts`, `packages/infra/test/Migrations.test.ts`,
  `packages/infra/src/Sql/migrations/20260909031311_initial/migration.sql`.
- Local smoke project (scratchpad, not committed): `src/worker.ts`,
  `wrangler.jsonc`, `pg-server.mjs` (embedded PostgreSQL 18.4), `server.mjs`
  (PGlite over `@electric-sql/pglite-socket`), `probe*.mjs`.

### Remote

- Cloudflare Hyperdrive docs (`https://developers.cloudflare.com/hyperdrive/llms-full.txt`,
  fetched 2026-09-09), in particular:
  - Get started: https://developers.cloudflare.com/hyperdrive/get-started/
  - How Hyperdrive works / pooling mode: https://developers.cloudflare.com/hyperdrive/concepts/how-hyperdrive-works/
  - Query caching: https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
  - node-postgres driver guide: https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/node-postgres/
  - Local development: https://developers.cloudflare.com/hyperdrive/configuration/local-development/
  - TLS/SSL: https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl/
  - Limits: https://developers.cloudflare.com/hyperdrive/platform/limits/
  - PlanetScale with Hyperdrive: https://developers.cloudflare.com/hyperdrive/planetscale/
- Cloudflare changelog, 2026-06-18, "Create PlanetScale Postgres and MySQL
  databases, billed to your Cloudflare account":
  https://developers.cloudflare.com/changelog/post/2026-06-18-planetscale-databases-cloudflare-billing/
- Cloudflare changelog, 2026-02-23, "Hyperdrive no longer caches queries using
  STABLE PostgreSQL functions":
  https://developers.cloudflare.com/changelog/post/2026-02-23-hyperdrive-stable-functions-uncacheable/
- Cloudflare blog, 2026-04-16, "Deploy PlanetScale Postgres with Workers":
  https://blog.cloudflare.com/deploy-planetscale-postgres-with-workers/
- Cloudflare blog, 2025-09, "PlanetScale Postgres + Workers" (connect existing
  PlanetScale databases from the dashboard):
  https://blog.cloudflare.com/planetscale-postgres-workers/
- Workers Node.js compatibility: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
- PlanetScale Postgres docs:
  - Connecting quickstart: https://planetscale.com/docs/postgres/connecting/quickstart
  - PgBouncer: https://planetscale.com/docs/postgres/connecting/pgbouncer
  - Roles: https://planetscale.com/docs/postgres/connecting/roles
  - Extensions: https://planetscale.com/docs/postgres/extensions
- Alchemy docs (GitHub `alchemy-run/alchemy`, `website/src/content/docs/`):
  `cloudflare/data/hyperdrive.mdx`, `cloudflare/data/drizzle.mdx`,
  `sql/effect-sql/postgres.mdx`, `planetscale/setup.mdx`,
  `planetscale/data/postgres.mdx`, `planetscale/data/migrations.mdx`
  (https://alchemy.run/docs/…).
- PostgreSQL `ALTER TYPE`: https://www.postgresql.org/docs/current/sql-altertype.html

## Working versions

| Package | Version | Note |
| --- | --- | --- |
| effect | 4.0.0-rc.112 | matches `.repos/effect` |
| @effect/sql-pg | 4.0.0-rc.112 | deps `pg ^8.23.0`, pg-pool, pg-cursor, pg-connection-string, pg-types |
| @effect/sql-pglite | 4.0.0-rc.112 | dep `@electric-sql/pglite ^0.5.6` |
| drizzle-orm | 1.0.0-rc.5-ab785fc | `effect-postgres` and `effect-pglite` entry points; the only build alchemy accepts (pinned exactly in alchemy's peers) |
| pg | 8.23.0 (pg-pool 3.14.0) | Hyperdrive minimum 8.16.3 |
| alchemy | 2.0.0-beta.76 | peers `pg ^8.22.0`, `@effect/sql-pg >=4.0.0-rc.112`, `drizzle-orm`/`drizzle-kit` `1.0.0-rc.5-ab785fc`; deps `@distilled.cloud/cloudflare` and `@distilled.cloud/planetscale` 1.0.0-rc.8. `feat/domain-package` currently pins beta.67 in the catalog; bump when wiring Hyperdrive. |
| wrangler | 4.130.0 (workerd 1.20260908.1) | `compatibility_date` 2026-09-01, flag `nodejs_compat` |
| PostgreSQL | 18.4 (embedded-postgres 18.4.0-beta.17) | local origin for the smoke |

## (a) Driver stack on Workers

**Which driver.** `drizzle-orm/effect-postgres` does not talk to the wire
itself: `make`/`makeWithDefaults` require a `PgClient` from `@effect/sql-pg`
(`effect-postgres/driver.d.ts`), and the session executes every statement via
`client.unsafe(sql, params)` (`pg-core/effect/session.js`, `effect-postgres/session.js`).
`PgClient.make` creates a `pg.Pool`, runs `SELECT 1` on acquire (5 s connect
timeout) and `pool.end()` on release with a 1 s cap; queries go through
`client.query(text, params)`, i.e. the extended protocol (`PgClient.ts`).
So the Worker-side stack is Drizzle → `@effect/sql-pg` → `pg` → `net`/`tls`
sockets, and Hyperdrive's support matrix for node-postgres is what applies.

**Hyperdrive and `pg`.** Hyperdrive documents node-postgres as a supported
driver; the node-postgres guide says "The minimum version of `node-postgres`
required for Hyperdrive is `8.16.3`" (`llms-full.txt` line 2627), while Get
started still says "v8.13.0 or later" (lines 462–501). `@effect/sql-pg`'s
`pg ^8.23.0` clears both. Hyperdrive supports named prepared statements for
node-postgres (blog "postgres-named-prepared-statements-supported-hyperdrive",
linked from the Hyperdrive docs). `nodejs_compat` is required because `pg`
uses `net`, `tls`, `events`, `stream` (Workers Node.js compatibility page:
`net` supported, `tls` partially; the flag is enabled by default for
`compatibility_date >= 2026-08-04`).

**Hyperdrive rules that constrain the layer.**
- Create clients inside the handler, not at module scope; Workers-to-Hyperdrive
  connections "are automatically cleaned up when the request or invocation
  ends, including when a Workflow or Queue consumer completes" and
  `client.end()` is not required (`llms-full.txt` line 963).
- Transaction pooling mode: "a connection is held for the duration of a
  transaction" (line 1057). `SET` applies for a transaction or a single
  query; on return to the pool the connection is `RESET` (line 1130).
- Limits (Limits page): ~20 origin connections per config on Free, ~100 on
  Paid; 60 s max statement duration; 10 min idle timeout; 50 MB max cached
  response.

**Verified locally (workerd, not the real Hyperdrive edge).** With the
`wrangler.jsonc` and `src/worker.ts` in section (i), `GET /` returned:

```json
{"ms":147,"hyperdriveHost":"…hyperdrive.local","hyperdrivePort":5432,
 "result":{"version":"PostgreSQL 18.4 …",
  "rows":[{"id":1,"name":"committed"},{"id":3,"name":"outer"}],
  "one":[{"id":1,"name":"committed"}],
  "rolledBack":{"ok":false,"error":"Error: boom"},
  "duplicate":{"tag":"EffectDrizzleQueryError","sqlReason":"UniqueViolation", …code 23505, constraint smoke_items_pkey…},
  "applicationNameAfterSet":"smoke-set"}}
```

Row 2 (inserted inside a failing Drizzle transaction) and row 4 (inserted in a
failing nested `withTransaction` savepoint) are absent; row 1 (Drizzle
transaction) and row 3 (outer `withTransaction`) are present. `GET /err`
confirms the connection is still usable after an error (`after: [{x:1}]`).
The `applicationNameAfterSet` line only shows the local passthrough reusing
one pooled connection; under real Hyperdrive the docs say a `SET` outside a
transaction is reset before the next query (line 1130), so session state must
not be relied on (relevant to `SET LOCAL`/RLS style code, not to this repo).

A first attempt used PGlite over `@electric-sql/pglite-socket` as the origin
and showed a response desync after a query error (results shifted by one
statement). Reproduced with plain `pg.Client` in Node (`probe2.mjs`: after a
23505 error `SELECT 1` returned `[]`, then "Received unexpected rowDescription
message"), so it is a pglite-socket extended-protocol bug, not workerd or
`@effect/sql-pg`. Switching the origin to a real PostgreSQL fixed it. Do not
use pglite-socket as a wire-level stand-in for Hyperdrive.

## (b) Connection scoping and transactions as an Effect layer

**Layer per request.** `PgClient.layer(config)` is `Layer.effect(PgClient, make(config))`
inside a scope; `make` acquires the `pg.Pool` and releases it when the layer's
scope closes (`PgClient.ts`). Providing that layer inside the handler with
`Effect.provide` gives exactly the lifetime Hyperdrive wants: pool created on
first use in the request, closed when the effect completes, nothing at module
scope. The smallest working layer used in the smoke:

```ts
class Db extends Context.Service<Db, PgDrizzle.EffectPgDatabase>()("infra/Db") {}

const makeDb = (url: string) =>
  Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
  )

// in fetch / a Workflow step
Effect.runPromiseExit(program.pipe(Effect.provide(makeDb(env.HYPERDRIVE.connectionString))))
```

`maxConnections: 1` is enough for a request that runs statements sequentially
and keeps the per-request origin footprint at one connection; raise it only
for handlers that deliberately fan out. Alchemy's `SQL.Postgres`/`Drizzle.Postgres`
do the same thing under the hood: `makeExecutionMemo` builds `PgClient.layer`
lazily "on the first query of an execution" and closes it "when the event
settles" (`Runtime/ExecutionMemo.ts`; `sql/effect-sql/postgres.mdx`).

**Workflow steps.** Hyperdrive cleans connections up when the Workflow
invocation completes (line 963). Each `step.do` callback should build the
layer the same way; a transaction cannot span steps (a step is a separate
retryable unit), so the layer-per-step shape is also the correct semantic
boundary. Expect the `SELECT 1` health check in `PgClient.make` to cost one
extra round trip per step; through Hyperdrive that is an edge-local pooled
connection, so it is cheap (a few ms), but it exists.

**`SqlClient.withTransaction` survives.** `withTransaction` reserves a
connection (`reserve` → `pool.connect` in `fromPool`), issues `BEGIN`, and on
nested use issues `SAVEPOINT effect_sql_<n>` (`SqlClient.ts` `make`). Because
Hyperdrive holds one origin connection for the duration of a transaction,
this maps 1:1 onto Hyperdrive's transaction pooling. Drizzle's
`db.transaction(fn)` is `client.withTransaction` (`effect-postgres/session.js`),
and an explicit rollback is `EffectTransactionRollbackError`. Both verified in
the smoke (rows 2 and 4 absent).

**Errors.** `@effect/sql-pg` classifies `pg` errors into `SqlError.reason`
tags (`UniqueViolation` with `constraint`, etc., `PgClient.ts`); Drizzle wraps
them in `EffectDrizzleQueryError` with the `SqlError` as `cause`. The smoke
extracted `reason._tag === "UniqueViolation"` and `constraint === "smoke_items_pkey"`,
which is what a lifecycle "already claimed" branch would match on.

## (c) Query caching

Hyperdrive caches "eligible read query results" by default (`max_age` 60 s,
`stale_while_revalidate` 15 s, Query caching page). Only queries without
volatile functions are cacheable, and since 2026-02-23 queries using
`STABLE` functions (`now()`, `current_timestamp`) are no longer cached
either (changelog 2026-02-23). A lifecycle read like
`SELECT … FROM scrapes WHERE state = 'queued'` uses no functions and **is**
cacheable, so a read right after a state transition can be stale for up to
60 s. That is not acceptable for claim/transition logic.

Disable it per configuration: wrangler `--caching-disabled` on create/update
(lines 1406–1417); API/JSON `"caching": { "disabled": true }` (line 2294);
Alchemy `Cloudflare.Hyperdrive.Connection(id, { caching: { disabled: true } })`
(`Connection.ts` `Caching { disabled?, maxAge?, staleWhileRevalidate? }`).
Cloudflare's own best-practice text recommends "a second Hyperdrive
configuration with `--caching-disabled`" for reads that must be fresh (line 1399).
Recommendation for this repo: one config with caching disabled for the
lifecycle Worker and Workflows; add a second, cached config later only if a
read-heavy catalog endpoint measures a need.

Drizzle's Effect cache is `EffectCache.Default = NoopCache`
(`cache/core/cache-effect.js`, `effect-core/defaults.js`), so no ORM-level
caching happens unless you pass a cache to `makeWithDefaults`.

## (d) PlanetScale as the origin

- **Port.** Direct connections use 5432; PlanetScale's PgBouncer uses 6432
  with the same credentials (PgBouncer page). PlanetScale-managed PgBouncers
  "operate in transaction pooling mode only" and the page recommends 5432 for
  DDL, session-specific features and long transactions. Hyperdrive is itself a
  transaction-mode pooler, so stacking it on PgBouncer buys nothing and adds a
  second RESET; point the Hyperdrive origin at **5432**. Alchemy encodes the
  same choice: `PostgresRole.origin` is the 5432 origin "ready to feed into
  Cloudflare Hyperdrive" and `pooledOrigin` (6432) is suggested for the
  Hyperdrive `dev` origin (`PostgresRole.ts` lines 116–119, 544, 552).
- **TLS.** "All PlanetScale Postgres connections require SSL/TLS";
  `sslmode=verify-full` and `sslrootcert=system` are documented as required,
  `sslnegotiation=direct` optional (quickstart). Hyperdrive's `sslmode`
  defaults to `require` and supports `verify-ca`/`verify-full` when a CA is
  uploaded (`wrangler cert upload certificate-authority`, TLS/SSL page;
  Alchemy `mtls: { caCertificateId, sslmode }`). Start with `require`;
  upgrade to `verify-full` once the CA is uploaded as an Alchemy-managed cert.
- **Username** is `{role}.{branch_id}`; password starts with `pscale_pw_`
  (quickstart).
- **Roles.** The default `postgres` role is `NOSUPERUSER CREATEDB CREATEROLE
  INHERIT LOGIN REPLICATION BYPASSRLS` plus `pg_read_all_data, pg_write_all_data,
  … pg_create_subscription` (Roles page). Custom roles built from
  `pg_read_all_data`/`pg_write_all_data` "do not grant the ability to run DDL
  such as CREATE TABLE"; the page suggests running migrations as the default
  role and giving the app a least-privilege role, optionally with a TTL
  (`pscale role create … --ttl 24h`).
- **Enums, `ALTER TYPE`, `jsonb`.** Nothing in the PlanetScale docs restricts
  these; the migration on `feat/domain-package` uses `CREATE TYPE … AS ENUM`,
  `timestamptz`, `uuid` and `jsonb`, all core Postgres. The one caveat is
  upstream Postgres, not PlanetScale: `ALTER TYPE … ADD VALUE` executed inside
  a transaction block leaves the new value unusable until commit
  (`sql-altertype`), and both migration runners below wrap each migration in a
  transaction, so a migration must not add an enum value and use it in the
  same file. Extensions are a curated list (Extensions page); none are needed
  for this schema.

## (e) Running the committed `migration.sql` from CI

Rule (already stated in `packages/infra/drizzle.config.ts` on
`feat/domain-package`): migrations go to PlanetScale over the direct 5432
connection, never through Hyperdrive (60 s statement cap, transaction pooling,
and the app role should not have DDL rights).

Options, all consuming drizzle-kit's committed `<ts>_<name>/migration.sql`:

1. **Alchemy at deploy time.** `Planetscale.PostgresBranch(id, { migrations })`
   (also `PostgresDatabase`) runs the pending files: it mints a temporary role
   inheriting `postgres` with a 600 s TTL (`PostgresMigrations.ts` line 25,
   133), connects with `pg` over 5432 with `ssl: { rejectUnauthorized: true }`
   (line 102), wraps each batch in `BEGIN`/`COMMIT` (`SQL/Migrations/PgExecutor.ts`
   lines 30–35) and records applied files in `__alchemy_migrations`. The
   drizzle-kit v1 directory layout is auto-detected (`SQL/Migrations/Detect.ts`).
   `migrations` can be a directory path or a `Drizzle.Schema` resource output
   (`cloudflare/data/drizzle.mdx`).
2. **Plain CI job.** `drizzle-kit migrate` (or a 30-line `pg` script that
   splits on `--> statement-breakpoint`, like `packages/infra/test/Migrations.test.ts`
   already does for PGlite) with `DATABASE_URL=postgresql://postgres.<branch>:…@…:5432/<db>?sslmode=verify-full`
   from a CI secret. Uses drizzle-kit's `drizzle.__drizzle_migrations`.
3. **Drizzle's Effect migrator** (`effect-postgres/migrator`), same bookkeeping
   table as 2, runs everything in one transaction; usable from a Node script
   with `PgClient.layer`.

Pick 1 if `alchemy deploy` is the only deploy path (credentials stay in
Alchemy's profile/CI env, migrations are ordered before the Worker that
depends on them). Pick 2 if migrations must be a separate, reviewable CI step.
Do not mix: `__alchemy_migrations` and `__drizzle_migrations` do not know about
each other.

## (f) Alchemy 2.0.0-beta.76: Hyperdrive and PlanetScale

**`Cloudflare.Hyperdrive.Connection`** (`Cloudflare/Hyperdrive/Connection.ts`):

```ts
type Scheme = "postgres" | "postgresql" | "mysql"                       // line 16
interface PublicOrigin { scheme; host; port?; database; user; password: Redacted }          // 22–30
interface AccessOrigin { scheme; host; database; user; password; accessClientId; accessClientSecret } // 37–43
interface Caching { disabled?: boolean; maxAge?: number; staleWhileRevalidate?: number }   // 53–63
interface Mtls { caCertificateId?: string; mtlsCertificateId?: string; sslmode?: "require" | "verify-ca" | "verify-full" } // 67–72
interface DevOrigin extends PublicOrigin { sslmode?: "disable" | "prefer" | "require" | "verify-ca" | "verify-full" } // 79
interface Props { name?; origin: PublicOrigin | AccessOrigin; caching?; mtls?; originConnectionLimit?: number; dev?: DevOrigin } // 88–111
// outputs: { hyperdriveId, name, accountId, origin, mtls, dev }             // 118–123
```

**Binding.** `Cloudflare.Hyperdrive.Connect(connection)` yields
`{ connectionString: Effect<Redacted<string>>, host, port, user, password, database, raw }`
and is provided by `Cloudflare.Hyperdrive.ConnectBinding` (`Connect.ts`,
`ConnectBinding.ts`). Deployed, `raw` is the Worker's `Hyperdrive` binding.
Under `alchemy dev` there is no Hyperdrive: `ConnectBinding` resolves the
`dev` origin if set, otherwise the real origin, with `sslmode` defaulting to
`"prefer"` (`ConnectBinding.ts` lines 53–63) and refuses Access origins in dev
(lines 68–69). So local dev talks to whatever `dev` points at directly, with no
pooling and no caching, same as wrangler's `localConnectionString`.

**PlanetScale provider** (`alchemy/Planetscale`): `PostgresDatabase(id, {
clusterSize, region?, replicas?, migrations?, importFiles? })`, `PostgresBranch`,
`PostgresRole(id, { database, branch, inheritedRoles, ttl? })` with outputs
`origin` (5432), `pooledOrigin` (6432), `connectionUrl` and `connectionUrlPooled`
(`?sslmode=verify-full`, `PostgresRole.ts` lines 522–552), and
`PostgresDefaultRole` (reads/rotates the default `postgres` role). Credentials
come from `PLANETSCALE_API_TOKEN_ID`, `PLANETSCALE_API_TOKEN`,
`PLANETSCALE_ORGANIZATION` or `alchemy profile edit --add Planetscale`
(`Planetscale/Credentials.ts`, `planetscale/setup.mdx`). There is no
`Password` resource; the role carries its password.

**Worked `alchemy.run.ts`** (condensed from `cloudflare/data/hyperdrive.mdx`
and `sql/effect-sql/postgres.mdx`, adapted to this repo's layer):

```ts
// alchemy.run.ts
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Planetscale from "alchemy/Planetscale"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export const Db = Effect.gen(function* () {
  const database = yield* Planetscale.PostgresDatabase("shelf-db", {
    region: { slug: "us-east" },
    clusterSize: "PS_10",
    migrations: "./packages/infra/src/Sql/migrations",   // drizzle-kit v1 layout, applied over 5432
  })
  const branch = yield* Planetscale.PostgresBranch("shelf-branch", {
    database, isProduction: true,        // parentBranch defaults to "main"
  })
  const role = yield* Planetscale.PostgresRole("shelf-app", {
    database, branch, inheritedRoles: ["pg_read_all_data", "pg_write_all_data"],
  })                                     // app role: no DDL; migrations use the temporary postgres-inheriting role
  return yield* Cloudflare.Hyperdrive.Connection("shelf-hyperdrive", {
    origin: role.origin,                 // host, port 5432, user `{role}.{branch_id}`, password
    caching: { disabled: true },         // lifecycle reads must be fresh
    mtls: { sslmode: "require" },        // verify-full once the CA is uploaded
    dev: role.pooledOrigin,              // alchemy dev: direct to PlanetScale's PgBouncer
  })
})

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
  Effect.gen(function* () {
    const hd = yield* Cloudflare.Hyperdrive.Connect(Db)
    return {
      fetch: Effect.gen(function* () { /* handler */ }).pipe(
        Effect.provide(makeDb(hd)),         // see below
      ),
    }
  }).pipe(Effect.provide(Cloudflare.Hyperdrive.ConnectBinding)),
) {}

export const Stack = Alchemy.Stack(
  "DigitalShelf",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Planetscale.providers()),
    state: Alchemy.localState(),
  },
  // resources/workers…
)
```

```ts
// packages/infra/src/Sql/Db.ts (Worker side)
const makeDb = (hd: Cloudflare.Hyperdrive.Connect) =>
  Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provideMerge(
      Layer.unwrap(Effect.map(hd.connectionString, (url) =>
        PgClient.layer({ url, maxConnections: 1 }))),
    ),
  )
```

Alchemy's own shortcut is `Drizzle.Postgres(hd.connectionString, { relations })`
or `SQL.PostgresLayer({ url })`, which provide `SqlClient`, `PgClient` and the
Drizzle db from one per-execution pool (`sql/effect-sql/postgres.mdx`,
`Drizzle/Postgres.ts`); use it if the infra package adopts Alchemy's runtime
wrapper, otherwise the explicit `PgClient.layer` above is equivalent.

## (g) PlanetScale linked from the Cloudflare dashboard

What shipped, in order:

1. **2025-09** (blog `planetscale-postgres-workers`): connect an *existing*
   PlanetScale database from the Cloudflare dashboard; "A Hyperdrive
   configuration will be created for your PlanetScale database", with
   "one-click password rotation"; attached Hyperdrive configs are also visible
   from the PlanetScale dashboard.
2. **2026-04-16** (blog `deploy-planetscale-postgres-with-workers`) and
   **2026-06-18** (changelog): *create* PlanetScale Postgres/MySQL databases
   from the Cloudflare dashboard, "bill PlanetScale database usage through your
   Cloudflare account as a pay-as-you-go customer"; usage appears on the
   Cloudflare invoice at PlanetScale's standard pricing, and "you receive the
   same PlanetScale developer experience, including development branches,
   query insights, and MCP server support". Per-database usage is inspected in
   PlanetScale's own dashboard, i.e. the database is a normal PlanetScale
   database in your PlanetScale org.
3. **Hyperdrive docs `/hyperdrive/planetscale/`**: CLI equivalent,
   `npx wrangler hyperdrive planetscale signature | pscale database create <name> --org <org> --engine postgresql --cloudflare-billing @-`
   (pscale >= 0.313.0, marked experimental). "Your PlanetScale credentials
   stay between you and `pscale`. Wrangler authorizes the Cloudflare billing
   side only."

**What it is:** a billing/account link and a dashboard convenience. It is
**not** a new Hyperdrive origin type and not a database inside Cloudflare's
account. Evidence: the Hyperdrive configuration API still takes a plain
`origin { host, port, database, user, password, scheme }` plus `caching`/`mtls`
(Hyperdrive API examples in the docs; wrangler's `createConfig` in
`src/hyperdrive/client.ts`); the only PlanetScale-specific API wrangler 4.130.0
calls is

```
POST /accounts/{account_id}/hyperdrive/integrationsOperations/planetScale/createDatabaseSignature
```

(`wrangler-dist/cli.js`, `createDatabaseSignature`), which returns
`{ account_id, timestamp, signature }` that PlanetScale's API consumes on
database creation.

**Can Alchemy express it?** No. `Cloudflare.Hyperdrive.Connection.origin` is
`PublicOrigin | AccessOrigin` only, and `alchemy/Planetscale` talks to the
PlanetScale API with a PlanetScale service token; neither calls the
`integrationsOperations` endpoint nor accepts a Cloudflare billing signature.
The same is true of the Cloudflare Terraform-style surface: nothing in the
Hyperdrive config resource references PlanetScale.

**Recommendation:** use plain Hyperdrive-over-PlanetScale-credentials, fully
declared in `alchemy.run.ts` as in (f). Whether the PlanetScale database is
billed to Cloudflare is orthogonal: a database created once via the dashboard
or the `pscale --cloudflare-billing` command is still an ordinary PlanetScale
database that `Planetscale.PostgresBranch`/`PostgresRole` can manage by name,
and the Hyperdrive config Alchemy creates for it is indistinguishable from the
dashboard-created one. If consolidated billing is wanted, create the database
that way once (out of band), then adopt it in Alchemy; do not rely on the
dashboard-created Hyperdrive config because its caching stays at the default
(enabled) unless changed.

## (h) Local and test story

- **Unit/integration tests**: keep PGlite in-process. `@effect/sql-pglite`
  (`PgliteClient.layer`) gives the same `SqlClient`/`PgClient`-shaped API
  (`PgliteClient.ts`), and Drizzle ships `drizzle-orm/effect-pglite`. The
  existing `packages/infra/test/Migrations.test.ts` already applies the
  committed `migration.sql` to PGlite; the repository tests can provide the
  Drizzle `Db` service from `effect-pglite` instead of `effect-postgres` with
  no change to callers. Caveat: `effect-postgres` requires `PgClient`
  specifically, so the `Db` service must be typed as the Drizzle database
  (as in `makeDb`), not as `PgClient`.
- **`wrangler dev`**: `localConnectionString` in the Hyperdrive binding (or
  `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>`) makes the
  binding a passthrough to a local Postgres with no pooling and no caching
  (Local development page). This is what the smoke used. Do not use
  pglite-socket as that Postgres (see (a)); `embedded-postgres` or Docker
  Postgres works.
- **`alchemy dev`**: `ConnectBinding` resolves `dev` (or the real origin) as
  described in (f); pointing `dev` at `role.pooledOrigin` gives a real
  PlanetScale branch over PgBouncer, or set `dev` to a local Postgres origin
  with `sslmode: "disable"` for offline work.
- **Hyperdrive-specific behaviour** (caching, SET reset, connection limits,
  60 s cap) cannot be exercised locally; that is what the deployed smoke is
  for.

## (i) Smoke

**Credentials check (2026-09-09).** No `CLOUDFLARE_API_TOKEN`/`PLANETSCALE_*`
env vars; `~/.alchemy` absent; `~/.wrangler/config/default.toml` holds an
expired OAuth token (2026-09-08) without a Hyperdrive scope; the only `wrangler`
on `PATH` is the deprecated v1 shim. Per the brief, no accounts were created
and nothing was prompted for. **The deployed transaction-and-rollback smoke
through Hyperdrive to PlanetScale is outstanding.**

**What ran locally** (workerd via `wrangler dev`, Hyperdrive local
passthrough, embedded PostgreSQL 18.4 on 127.0.0.1:54330): all three probes
above, results in (a). `tsc --noEmit` (strict) passes on the Worker.

**Proposed deployed smoke.** Same Worker; only the binding changes. With
Alchemy, replace `wrangler.jsonc` by the `alchemy.run.ts` in (f) with
`Api.main` pointing at `worker.ts` and `caching: { disabled: true }`. With
wrangler:

```jsonc
// wrangler.jsonc
{
  "name": "hyperdrive-effect-smoke",
  "main": "src/worker.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "<id from `wrangler hyperdrive create smoke --connection-string 'postgresql://postgres.<branch>:pscale_pw_…@<host>:5432/<db>?sslmode=require' --caching-disabled`>",
                   "localConnectionString": "postgres://postgres:postgres@127.0.0.1:54330/postgres" }]
}
```

```ts
// src/worker.ts — one PgClient per request, built inside the handler
import * as PgClient from "@effect/sql-pg/PgClient"
import { eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { integer, pgTable, text } from "drizzle-orm/pg-core"
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

const items = pgTable("smoke_items", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
})

class Db extends Context.Service<Db, PgDrizzle.EffectPgDatabase>()("smoke/Db") {}

const makeLayer = (url: string) =>
  Layer.effect(Db, PgDrizzle.makeWithDefaults()).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url), maxConnections: 1 })),
  )

const describeExit = <A>(exit: Exit.Exit<A, unknown>) =>
  Exit.isSuccess(exit)
    ? { ok: true as const, value: exit.value }
    : { ok: false as const, error: Cause.pretty(exit.cause).split("\n")[0] }

const program = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const db = yield* Db

  yield* sql`CREATE TABLE IF NOT EXISTS smoke_items (id integer PRIMARY KEY, name text NOT NULL)`
  yield* sql`DELETE FROM smoke_items`
  const version = yield* sql<{ version: string }>`SELECT version()`

  // 1. Drizzle transaction that commits.
  yield* db.transaction((tx) => tx.insert(items).values({ id: 1, name: "committed" }))

  // 2. Drizzle transaction that fails -> ROLLBACK (row 2 absent).
  const rolledBack = yield* db
    .transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(items).values({ id: 2, name: "rolled back" })
        return yield* Effect.fail(new Error("boom"))
      }),
    )
    .pipe(Effect.exit)

  // 3. SqlClient.withTransaction with a failing nested savepoint (row 3 present, row 4 absent).
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`INSERT INTO smoke_items (id, name) VALUES (3, 'outer')`
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO smoke_items (id, name) VALUES (4, 'inner')`
            yield* sql`SELECT 1/0`
          }),
        )
        .pipe(Effect.ignore)
    }),
  )

  // 4. Constraint violation classification.
  const duplicate = yield* db.insert(items).values({ id: 1, name: "dup" }).pipe(Effect.exit)

  // 5. SET outside a transaction; under real Hyperdrive expect it NOT to persist.
  yield* sql`SET application_name = 'smoke-set'`
  const appName = yield* sql<{ application_name: string }>`SHOW application_name`

  const rows = yield* db.select().from(items).orderBy(items.id)
  const one = yield* db.select().from(items).where(eq(items.id, 1))

  return {
    version: version[0]?.version,
    rows,
    one,
    rolledBack: describeExit(rolledBack),
    duplicate: Exit.isFailure(duplicate)
      ? {
          tag: (Cause.squash(duplicate.cause) as { _tag?: string })._tag,
          sqlReason: (Cause.squash(
            (Cause.squash(duplicate.cause) as { cause: Cause.Cause<SqlError> }).cause,
          ) as SqlError).reason._tag,
        }
      : "unexpected success",
    applicationNameAfterSet: appName[0]?.application_name,
  }
})

export default {
  async fetch(request: Request, env: { HYPERDRIVE: Hyperdrive }) {
    const started = Date.now()
    const exit = await Effect.runPromiseExit(
      program.pipe(Effect.provide(makeLayer(env.HYPERDRIVE.connectionString))),
    )
    return Response.json(
      {
        ms: Date.now() - started,
        hyperdriveHost: env.HYPERDRIVE.host,
        result: Exit.isSuccess(exit) ? exit.value : { failure: Cause.pretty(exit.cause) },
      },
      { status: Exit.isSuccess(exit) ? 200 : 500 },
    )
  },
}
```

Expected deployed result: `rows` = ids 1 and 3, `rolledBack.ok === false`,
`duplicate.sqlReason === "UniqueViolation"`, and (unlike locally)
`applicationNameAfterSet` is the default (empty or the pool's name) because
Hyperdrive resets the connection between the `SET` and the `SHOW`. Also worth
recording: `ms` for a warm request (Hyperdrive pooled) versus first request,
and that a second `GET /` within 60 s on a caching-**enabled** config returns
the `rows` from before the `DELETE` (proves the caching hazard), versus fresh
rows on the caching-disabled config.

## Recommended shape

- `packages/infra`: `Cloudflare.Hyperdrive.Connection` with
  `caching: { disabled: true }`, origin from `Planetscale.PostgresRole.origin`
  (port 5432, app role = `pg_read_all_data` + `pg_write_all_data`), `mtls.sslmode`
  `require` now, `verify-full` when the CA cert is managed. Bump alchemy to
  >= 2.0.0-beta.76 for the Effect-edition `Planetscale` provider.
- `Db` service = Drizzle `EffectPgDatabase`, provided per request/step by
  `Layer.effect(Db, PgDrizzle.makeWithDefaults())` over
  `PgClient.layer({ url, maxConnections: 1 })`; tests provide the same `Db`
  from `drizzle-orm/effect-pglite` + `@effect/sql-pglite`.
- Transactions via `db.transaction` / `sql.withTransaction`; treat
  `SqlError.reason._tag` (`UniqueViolation`) as the claim-conflict signal.
- Migrations: committed drizzle-kit files applied over 5432 by either
  `Planetscale.PostgresBranch({ migrations })` at deploy or a CI job with the
  default role; never through Hyperdrive; never add-and-use an enum value in
  one migration.
- Ignore the dashboard/billing link for infrastructure purposes; it changes
  who pays, not how Hyperdrive or Alchemy see the database.

## Unverified items

- **Deployed smoke** (transaction, rollback, savepoint, `SET` reset, caching
  hazard) through real Hyperdrive to PlanetScale: not run, no credentials.
- Real-Hyperdrive latency of `PgClient.make`'s `SELECT 1` health check per
  request/step; local passthrough showed ~20 ms warm total, not comparable.
- Whether `pscale`'s `--cloudflare-billing` databases expose anything
  different through PlanetScale's API (name, org, plan) that
  `alchemy/Planetscale` would trip on when adopting them; nothing in the docs
  suggests so.
- An exhaustive scan of the Cloudflare OpenAPI schema for other
  `integrationsOperations` endpoints; only the `createDatabaseSignature` call
  used by wrangler 4.130.0 was located.
- `verify-full` from Hyperdrive to PlanetScale (which CA to upload: the docs
  say `sslrootcert=system`, i.e. a public CA; expected to work with Hyperdrive's
  `verify-full` once that CA is uploaded, not tested).
