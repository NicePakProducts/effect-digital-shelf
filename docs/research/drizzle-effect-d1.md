# Drizzle with Effect on the v4 RC and D1

Research for [#3](https://github.com/NicePakProducts/effect-digital-shelf/issues/3) (part of #1). Written 2026-09-08 for a fresh build on Effect 4.0.0-rc.112, Cloudflare D1 and Alchemy; nothing here assumes or migrates existing code.

## TL;DR

1. **There is an RC-compatible Drizzle integration, and it lives inside `drizzle-orm`, not in an `@effect/*` package.** `@effect/sql-drizzle` is Effect v3 only and was deleted in v4; its replacement is `drizzle-orm/effect-d1` (plus `effect-core`, `effect-schema`, and one `effect-*` module per `@effect/sql-*` driver). Do not hand-wrap `drizzle-orm/d1`'s promise driver.
2. **Version trap:** `drizzle-orm@rc` (`1.0.0-rc.4`) crashes at import against `effect@4.0.0-rc.112` (`Schema.TaggedErrorClass is not a function`). Use the rc5 pre-release builds (`1.0.0-rc.5-ab785fc` is what Alchemy pins; the `rc5` dist-tag currently points at `1.0.0-rc.5-169397b`). Verified by a smoke test (below).
3. **Sharing the binding:** `drizzle-orm/effect-d1` does not open D1 itself; it needs `@effect/sql-d1`'s `D1Client` service and pushes every query through `D1Client.unsafe(sql, params)`. One `D1Client.layer({ db })` therefore feeds both the tagged-template `SqlClient` and the Drizzle `Db` service from a single binding and prepared-statement cache.
4. **Migrations:** `drizzle-kit generate` writes `<out>/<timestamp>_<name>/{migration.sql,snapshot.json}`. Alchemy's `Cloudflare.D1.Database` reads that layout directly via its `migrations` prop (older Alchemy: `migrationsDir`), splits on `--> statement-breakpoint`, applies pending files as one D1 batch on deploy and keeps its own `__alchemy_migrations` table. Drizzle's own runtime migrator is unusable on D1 (it wraps the run in a transaction).
5. **Transactions do not exist on D1.** `db.transaction(...)` from `effect-d1` calls `SqlClient.withTransaction`, which `@effect/sql-d1` implements as `Effect.die("transactions are not supported in D1")`. Atomic multi-statement writes go through `D1Client.batch`, fed by Drizzle builders' `.toSQL()`.
6. **Typed errors:** Drizzle queries fail with `EffectDrizzleQueryError { query, params, cause: Cause<SqlError> }`; raw `sql` fails with `SqlError`. On D1 every `SqlError.reason` is `UnknownError` (the driver does no classification). Repositories should map both into one domain-tagged error per repository.

## Sources

Local (read directly):

- Effect v4 RC checkout at `.repos/effect` (package version `4.0.0-rc.112`): `migration/v3-to-v4.md`, `packages/sql/d1/src/D1Client.ts`, `packages/effect/src/unstable/sql/{SqlClient,SqlError,Statement,Migrator}.ts`, `packages/effect/CHANGELOG.md`.
- Ticket-requested reference snapshot `.repos/slopcop/packages/infra/src/Sql.ts` and `packages/github/src/repositories/*.ts` (only consulted for the Alchemy D1 -> `SqlClient` wiring and its pinned versions; no design below depends on it).
- Packages downloaded from npm and read/executed in a scratch dir: `drizzle-orm@1.0.0-rc.4`, `drizzle-orm@1.0.0-rc.5-ab785fc`, `effect@4.0.0-rc.112`, `@effect/sql-d1@4.0.0-rc.112`, `alchemy@2.0.0-beta.67` (tarball).

Remote (fetched 2026-09-08):

- npm registry: `npm view` on `@effect/sql-drizzle`, `drizzle-orm`, `drizzle-kit`, `@effect/sql-d1`, `effect`, `alchemy`.
- Drizzle docs: <https://orm.drizzle.team/docs/connect-cloudflare-d1>, <https://orm.drizzle.team/docs/get-started/d1-new>, <https://orm.drizzle.team/docs/drizzle-kit-generate>, <https://orm.drizzle.team/docs/migrations>, <https://orm.drizzle.team/docs/connect-effect-postgres>. Release notes via `gh api repos/drizzle-team/drizzle-orm/releases`.
- Alchemy source on `main` (`packages/alchemy/src/SQL/D1.ts`, `Drizzle/D1.ts`, `Drizzle/index.ts`, `Drizzle/Schema.ts`, `Cloudflare/D1/Database.ts`, `Cloudflare/D1/ApplyMigrations.ts`, `SQL/Migrations/{Detect,Format,Convert,Registry}.ts`, `test/SQL/Migrations/DrizzleInterop.test.ts`) and docs (`website/src/content/docs/sql/drizzle/d1.mdx`, `sql/drizzle/migrations.mdx`, `sql/effect-sql/d1.mdx`, `cloudflare/data/d1-drizzle.mdx`), all at <https://github.com/alchemy-run/alchemy>.
- Cloudflare D1 Worker API: <https://developers.cloudflare.com/d1/worker-api/d1-database/>.

## (a) Is there an Effect v4 RC-compatible Drizzle integration?

**Yes: it is shipped by Drizzle itself.**

- `@effect/sql-drizzle` is v3-only and unmaintained for v4. Latest is `0.51.0` (modified 2026-07-13) with peers `effect ^3.22.0`, `@effect/sql ^0.52.0`, `drizzle-orm >=0.43.1 <0.50`; its only dist-tags are `latest` and `snapshot`, no `beta`/`rc` (`npm view @effect/sql-drizzle dist-tags peerDependencies`).
- The v4 migration reference removes it outright and points at Drizzle: "`@effect/sql-drizzle/Sqlite`: No single module replacement", then per API: "`Sqlite.make` -> `drizzle-orm/effect-sqlite-node#makeWithDefaults`: SQLite integration is backend-specific; use the module matching sql-sqlite-node, -bun, -do, -wasm, libsql, or d1" and "`Sqlite.layer` -> `Layer.effect(AppDb, SqliteDrizzle.makeWithDefaults())`: The package was removed; select the matching drizzle-orm Effect backend module, define an application service tag, and compose with its SQL client layer" (`.repos/effect/migration/v3-to-v4.md` lines 601-603 and 7723-7733). By contrast Kysely's integration was dropped with "No Effect-native equivalent remains" (line 604).
- `drizzle-orm` 1.0 pre-releases export the Effect modules: `drizzle-orm@rc` = `1.0.0-rc.4` exports `./effect-core`, `./effect-d1`, `./effect-libsql`, `./effect-mysql2`, `./effect-pglite`, `./effect-postgres`, `./effect-schema`, `./effect-sqlite-bun`, `./effect-sqlite-do`, `./effect-sqlite-node`, `./effect-sqlite-wasm`, with peers `effect >=4.0.0-beta.83 || >=4.0.0` and `@effect/sql-d1 >=4.0.0-beta.83 || >=4.0.0` (`npm view drizzle-orm@rc exports peerDependencies`). The stable `latest` (`0.45.2`) has none of these.
- Release notes: `v1.0.0-rc.1` (2026-04-30) "comes with native support for Effect v4"; `v1.0.0-rc.4` (2026-06-27) "Added `@effect/sql-d1` driver support" and "Bump required `effect` package versions to `4.0.0-beta.83`"; `v1.0.0-beta.13` reshaped the API to `PgDrizzle.make`/`makeWithDefaults`.
- Drizzle's own docs cover only the Postgres flavour (<https://orm.drizzle.team/docs/connect-effect-postgres>); the D1 page still shows the promise driver `drizzle-orm/d1`. The D1 flavour is documented by its typings and by Alchemy's docs (`sql/drizzle/d1.mdx`: "the `drizzle-orm/effect-d1` driver (built on `@effect/sql-d1`)").

**What `drizzle-orm/effect-d1` actually is** (from `package/effect-d1/driver.d.ts`, `driver.js`, `session.js` in the rc5 tarball; identical in rc.4 apart from import order):

- `make(config): Effect<EffectSQLiteD1Database & { $client: D1Client }, never, EffectCache | EffectLogger | D1Client>` and `makeWithDefaults(config)` which pre-provides `DefaultServices` (no-op logger and cache). Config is `EffectDrizzleSQLiteD1Config<TRelations>` (`relations`, casing, etc.).
- The session executes every query as `this.client.unsafe(query.sql, params)` and picks `.withoutTransform` (objects), `.values` (arrays) or `.raw` (run). So Drizzle is a typed query builder on top of the Effect SQL client; it never touches the `D1Database` binding itself.
- `session.transaction(fn)` is `this.client.withTransaction(...)` (see (d)).
- Every builder is an `Effect` you `yield*` directly; the error channel is `EffectDrizzleQueryError` (`effect-core/errors.d.ts`: fields `query: string`, `params: unknown[]`, `cause: unknown`; built with `Schema.TaggedError`). Transactions add `SqlError`.
- The module has no migrator (`effect-d1/` contains only `driver`, `session`, `index`), unlike `effect-postgres/migrator`.

**Version pin (verified).** Installing `effect@4.0.0-rc.112` + `@effect/sql-d1@4.0.0-rc.112` with `drizzle-orm@1.0.0-rc.4` and importing `drizzle-orm/effect-d1` throws at module load:

```
TypeError: Schema$1.TaggedErrorClass is not a function ... drizzle-orm/cache/core/cache-effect.js:97
```

Cause: Effect renamed the constructor ("`Schema.TaggedErrorClass` is now `Schema.TaggedError`", PR #6732, listed under `4.0.0-beta.104` in `packages/effect/CHANGELOG.md`); `unpkg.com/effect@<v>/dist/Schema.d.ts` mentions `TaggedErrorClass` in `4.0.0-beta.103` and not in `beta.104`, `beta.107`, `rc.109`, `rc.110` or `rc.112`. rc.4's peer range (`>=4.0.0-beta.83`) is therefore wrong. `drizzle-orm@1.0.0-rc.5-ab785fc` (published 2026-08-11, peers `effect >=4.0.0-beta.105`, `@effect/sql-d1 >=4.0.0-beta.105`) loads and runs. Alchemy `2.0.0-beta.76` pins `drizzle-orm` and `drizzle-kit` to exactly `1.0.0-rc.5-ab785fc` as peers, with the doc comment "pinned exactly because rc.4 breaks against effect >= 4.0.0-rc.110" (`cloudflare/data/d1-drizzle.mdx`). Their version boundary (rc.110) differs from what the unpkg check shows (beta.104); either way rc.4 is unusable on rc.112. Unverified: whether a plain `1.0.0-rc.5` will be published with the same API before this project ships; watch the `rc5` tag.

Smoke test result on rc5-ab785fc + effect rc.112 with a fake `D1Database` (scratch script, not committed): `db.select().from(users).where(eq(users.id, 1))` executes `select "id", "email" from "users" where "users"."id" = ?`; tagged-template `sql` on the same client works; a failing Drizzle query surfaces as `EffectDrizzleQueryError` whose `cause` is a `Cause` wrapping `SqlError` with `reason._tag === "UnknownError"`; `D1Client.batch` runs; `db.transaction(...)` dies with `Error: transactions are not supported in D1`; `tsc --strict` passes.

## (b) How a Drizzle client shares or replaces the `SqlClient` layer on the Alchemy D1 binding

**Everything hangs off one `D1Client`.**

- `@effect/sql-d1`'s `D1Client.layer(config)` returns `Layer<D1Client | SqlClient>`: it builds one client and registers it under both tags (`Context.make(D1Client, client).pipe(Context.add(Client.SqlClient, client))`, `D1Client.ts` `layer`). The client is `Client.make(...)` plus `batch` and a `config`; `updateValues` is typed `never` ("Not supported in d1").
- `drizzle-orm/effect-d1`'s `make` does `yield* D1Client` (the D1-specific tag, not the generic `SqlClient`), so a Drizzle database is always derived from an existing `D1Client`; you cannot construct it from the raw binding or from a generic `SqlClient`.
- Alchemy's runtime helpers (`alchemy@2.0.0-beta.76`, `packages/alchemy/src/SQL/D1.ts` and `Drizzle/D1.ts`):
  - `Cloudflare.D1.QueryDatabase(resource)` yields a client whose `.raw` is `Effect<D1Database>`; both helpers accept that client or a bare `Effect<D1Database>`.
  - `SQL.D1(d1, config?)` builds `D1Client.layer({ ...config, db })` lazily, memoized per execution (one client and prepared-statement cache per `fetch`/`queue`/`scheduled` event, torn down when the event settles), and returns a chainable proxy over `D1Client`. `SQL.D1Layer(d1)` exposes it as both `SqlClient` and `D1Client`, documented as suitable for "drizzle's `effect-d1` driver, which depends on `D1Client`".
  - `Drizzle.D1(d1, { relations })` does the same but builds `D1Client.layer({ db })` **internally** and then `SQLiteD1Drizzle.makeWithDefaults(config)`; it does not consume an ambient `D1Client`. Using `SQL.D1` and `Drizzle.D1` side by side therefore creates two `D1Client`s per execution (two prepared-statement caches). Harmless, but not "shared".
- `alchemy/Drizzle` re-exports `EffectDrizzleError`, `EffectDrizzleQueryError`, `EffectTransactionRollbackError`, `MigratorInitError` from `drizzle-orm/effect-core` (`Drizzle/index.ts`).

**Recommendation for the new codebase:** treat `D1Client` as the single infrastructure layer and derive two application-facing services from it: `Db` (Drizzle) for typed queries and `SqlClient` for raw SQL and `D1Client.batch`. Concretely:

```ts
// infra/D1.ts
import * as D1Client from "@effect/sql-d1/D1Client"
import * as SQLiteD1Drizzle from "drizzle-orm/effect-d1"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Cloudflare from "alchemy/Cloudflare"
import { relations } from "../schema.ts"

export class Db extends Context.Service<Db, SQLiteD1Drizzle.EffectSQLiteD1Database<typeof relations>>()("app/Db") {}

// Provides D1Client + SqlClient from the Alchemy-bound D1Database.
export const D1Live = (database: ReturnType<typeof Cloudflare.D1.Database>) =>
  Layer.unwrap(
    Effect.gen(function*() {
      const resource = yield* database
      const d1 = yield* Cloudflare.D1.QueryDatabase(resource)
      const db = yield* d1.raw
      return D1Client.layer({ db })
    })
  )

export const DbLive = Layer.effect(Db, SQLiteD1Drizzle.makeWithDefaults({ relations }))
// Composed: Db, D1Client and SqlClient all come from the one client.
export const DatabaseLive = (database: ReturnType<typeof Cloudflare.D1.Database>) =>
  DbLive.pipe(Layer.provideMerge(D1Live(database)))
```

Notes:

- If per-execution laziness matters (Alchemy builds the client on first query and destroys it when the event settles), prefer Alchemy's `SQL.D1Layer(d1)` as `D1Live` and keep `DbLive` as above on top of it; that still yields one shared client. `Drizzle.D1` is the convenience path when no raw `SqlClient` is needed. Unverified: how `Layer.unwrap` above interacts with Alchemy's Worker lifecycle (plan/deploy time never resolving the binding); Alchemy's helpers are the tested path.
- `transformQueryNames`/`transformResultNames` on `D1ClientConfig` do not apply to Drizzle: the session uses `unsafe(...).withoutTransform`/`.values`/`.raw`. Column naming for Drizzle comes from the schema (`text("user_id")`) or from Drizzle's casing API (moved to table/schema level in rc.4: "`import { snakeCase, camelCase } from "drizzle-orm/dialect-core"`", release notes). Only enable the client transforms if raw `sql` queries want camelCase rows.

## (c) How drizzle-kit migration output feeds Alchemy's D1 migrations

**What drizzle-kit produces** (`drizzle-kit@rc` = `1.0.0-rc.4`; docs `drizzle-kit-generate`, `migrations`):

- `drizzle-kit generate` reads the schema, diffs against the latest snapshot and saves "`migration.sql` and `snapshot.json` in migration folder under current timestamp": `drizzle/20242409125510_premium_mister_fear/{migration.sql,snapshot.json}`. `--name=init` names the folder; `--custom` creates an empty migration for hand-written SQL.
- The pre-1.0 layout (`0000_init.sql` files plus `meta/_journal.json`) is converted with `drizzle-kit up`.
- Config for D1 (docs `get-started/d1-new`): `defineConfig({ out: './drizzle', schema: './src/db/schema.ts', dialect: 'sqlite', driver: 'd1-http', dbCredentials: { accountId, databaseId, token } })`. `driver: 'd1-http'` and the credentials are only needed for `drizzle-kit migrate/push/studio` against the remote database; Alchemy invokes `generate` with just `--dialect sqlite --schema ... --out ...` (`Drizzle/Schema.ts`), so a generate-only config needs no credentials. Statements inside a file are separated by `--> statement-breakpoint` (Alchemy `Format.ts`).

**How Alchemy consumes it** (`packages/alchemy/src/Cloudflare/D1/Database.ts` on `main`, npm `2.0.0-beta.76`):

- Prop `migrations?: MigrationsInput` where `MigrationsInput = string | { dir: string; table?: string } | { out: string }`. A string is the directory; `{ out }` is the structural shape of a `Drizzle.Schema` resource so `migrations: schema` orders generate-before-apply in one deploy (`Registry.ts`). Example in the docs: `Cloudflare.D1.Database("app-db", { migrations: "./drizzle" })` with the comment "drizzle-kit's default out".
- **API drift to watch:** `alchemy@2.0.0-beta.67` has `migrationsDir?: string` / `migrationsTable?: string` props instead ("Point `migrationsDir` at a folder of `.sql` files", `Database.ts` lines 83-95 in that tarball, with a `migrationsTable: "drizzle_migrations"` example). On `main` those names survive only as resource *outputs*. Pin the Alchemy version and use whichever prop it exposes.
- Layout detection (`SQL/Migrations/Detect.ts`): a directory whose entries match `<ts>_<name>/migration.sql` is `"directory"` (drizzle-kit v1 and Prisma layouts; records keyed by directory name); otherwise `"flat"` (plain `.sql` files keyed by path). A `meta/_journal.json` (drizzle v0) fails with `DrizzleV0LayoutError`: "Upgrade drizzle-kit and run \"drizzle-kit up\" to convert it, then redeploy."
- Bookkeeping: always Alchemy's `__alchemy_migrations` table (`table` overrides the name). A database previously migrated with `drizzle-kit migrate` is adopted one-way: rows from `__drizzle_migrations` are copied (hashes are sha256 of `migration.sql` in both tools, so they carry over verbatim), the drizzle table is frozen, and only pending migrations run (`Convert.ts`, `DrizzleInterop.test.ts`, `sql/drizzle/migrations.mdx`). Fixtures cover both `drizzle-v0` and `drizzle-v1` layouts.
- Application: each pending migration's statements are joined into one multi-statement query against the D1 HTTP API ("D1 over HTTP has no transactions, so one batched call is the closest available unit (matching wrangler's own behavior)", `ApplyMigrations.ts`). `alchemy dev` applies the same flow against the local miniflare D1.
- Optional `Drizzle.Schema("app-schema", { schema, out, dialect: "sqlite" })` runs drizzle-kit's programmatic generate on deploy. Non-interactively, drizzle-kit `>= 1.0.0-rc.4` exits 2 with a `missing_hints` report on ambiguous changes (rename vs create, data loss) and Alchemy fails the deploy with instructions to run `drizzle-kit generate` manually and commit (`Drizzle/Schema.ts`). Destroy never deletes migration files.

**Recommended flow:** commit `drizzle.config.ts` (`dialect: "sqlite"`, `schema`, `out: "./migrations"`), run `drizzle-kit generate` in development (or wire `Drizzle.Schema` if deploy-time generation is wanted), commit the `migrations/` folder, and point `Cloudflare.D1.Database(..., { migrations: "./migrations" })` at it. Do not use `drizzle-kit migrate`, `wrangler d1 migrations apply`, or Drizzle's runtime `migrate()` on the same database; Alchemy owns the bookkeeping after first deploy.

**Runtime migration is not an option on D1 via Drizzle:** `sqlite-core/effect/session.js` `migrate` wraps the run in `session.transaction(...)`, which dies on `@effect/sql-d1`. Effect's own `effect/unstable/sql/Migrator` (`fromGlob`/`fromRecord` loaders) exists but was not exercised against D1 in this research; it is unnecessary given deploy-time application.

## (d) Recommended shape: repositories, transactions, typed errors

### Facts that shape the design

- **No transactions on D1.** `D1Client.make` sets `transactionAcquirer = Effect.die("transactions are not supported in D1")` and `Client.make` uses it for `withTransaction`/`reserve` (`D1Client.ts`; `SqlClient.ts` `make`, lines 156-179). `effect-d1`'s `session.transaction` calls `client.withTransaction`, so `db.transaction(...)` is a defect, not a typed failure (confirmed at runtime). Streaming (`executeStream`) also dies.
- **Batches are the atomic unit.** `D1Client.batch(statements)` sends prepared statements through `D1Database.batch` in one request; per Cloudflare, "Batched statements are SQL transactions. If a statement in the sequence fails, then an error is returned for that specific statement, and it aborts or rolls back the entire sequence." The source notes "D1 batches execute on the binding directly and intentionally cannot participate in SqlClient transactions." Batch returns the per-statement row arrays (`D1Client.ts` `makeBatch`). Drizzle effect builders expose `.toSQL()` (`{ sql, params }`), and `sql.unsafe(sql, params)` turns that into a `Statement` accepted by `batch` (verified: an `update` and an `insert` built by Drizzle were batched with their bound params).
- **Error types.** Raw `sql` fails with `SqlError` (`effect/unstable/sql/SqlError`, a `Schema.TaggedError` with `reason: SqlErrorReason`). `@effect/sql-d1` classifies every failure as `UnknownError` (`classifyError` in `D1Client.ts`), so `UniqueViolation`/`ConstraintError` never appear on D1 even though `SqlError.classifySqliteError` exists in `SqlError.ts` (line 513); apply it yourself to `reason.cause` if constraint-specific handling is needed (unverified whether D1's error messages match its patterns). Drizzle fails with `EffectDrizzleQueryError` whose `cause` is `Cause.fail(sqlError)` (`sqlite-core/effect/session.js` line 96; confirmed `Cause.isCause(e.cause)` and `Cause.squash(e.cause)._tag === "SqlError"`).
- **Effect v4 service/error primitives:** `Context.Service<Self, Shape>()("id", { make })` (`Context.ts` line 201), `Schema.TaggedError<Self>("id")("Tag", fields)` (pattern used by `SqlError.ts`), `Layer.effect`, `Layer.provideMerge`.

### Shape

```
schema.ts            drizzle tables + defineRelations (single source of truth; drizzle-kit reads it)
infra/D1.ts          D1Live (D1Client + SqlClient from the Alchemy binding), Db service, DbLive
infra/DbError.ts     DbError: one Schema.TaggedError wrapping EffectDrizzleQueryError | SqlError
infra/Batch.ts       atomically(): Drizzle builders -> toSQL -> D1Client.batch
<feature>/Repo.ts    Context.Service per aggregate; methods return Effect<A, <Repo>Error>
migrations/          drizzle-kit generate output, committed; consumed by Cloudflare.D1.Database({ migrations })
```

```ts
// infra/DbError.ts
import * as Schema from "effect/Schema"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"

export type DbCause = EffectDrizzleQueryError | SqlError

export class DbError extends Schema.TaggedError<DbError>("app/DbError")("DbError", {
  operation: Schema.String,
  cause: Schema.Defect()
}) {}
```

```ts
// infra/Batch.ts -- atomic multi-statement write on D1
import * as D1Client from "@effect/sql-d1/D1Client"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Effect from "effect/Effect"

export interface ToSQL { toSQL(): { sql: string; params: unknown[] } }

export const atomically = (...queries: ReadonlyArray<ToSQL>) =>
  Effect.gen(function*() {
    const d1 = yield* D1Client.D1Client
    const sql = yield* SqlClient.SqlClient
    return yield* d1.batch(queries.map((q) => {
      const { sql: text, params } = q.toSQL()
      return sql.unsafe(text, params as Array<any>)
    }))
  })
```

```ts
// products/ProductsRepo.ts
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { eq } from "drizzle-orm"
import { Db } from "../infra/D1.ts"
import { DbError, type DbCause } from "../infra/DbError.ts"
import { atomically } from "../infra/Batch.ts"
import { products, listings } from "../schema.ts"

export class ProductsRepoError extends DbError {}  // or a per-repo Schema.TaggedError with an `operation` literal union

export class ProductsRepo extends Context.Service<ProductsRepo, {
  readonly findById: (id: string) => Effect.Effect<Option.Option<typeof products.$inferSelect>, DbError>
  readonly upsertWithListings: (
    product: typeof products.$inferInsert,
    rows: ReadonlyArray<typeof listings.$inferInsert>
  ) => Effect.Effect<void, DbError>
}>()("app/ProductsRepo", {
  make: Effect.gen(function*() {
    const db = yield* Db
    const fail = (operation: string) => (cause: DbCause) => new DbError({ operation, cause })

    return {
      findById: (id) =>
        db.query.products.findFirst({ where: { id }, with: { listings: true } }).pipe(
          Effect.map(Option.fromNullishOr),
          Effect.mapError(fail("findById"))
        ),

      // Several statements that must succeed or fail together: one D1 batch, not a transaction.
      upsertWithListings: (product, rows) =>
        atomically(
          db.insert(products).values(product).onConflictDoUpdate({ target: products.id, set: product }),
          db.delete(listings).where(eq(listings.productId, product.id)),
          db.insert(listings).values(rows)
        ).pipe(Effect.asVoid, Effect.mapError(fail("upsertWithListings")))
    }
  })
}) {}

export const ProductsRepoLive = Layer.effect(ProductsRepo, ProductsRepo.make)
```

Guidelines that follow from the sources:

- **Repositories depend on `Db`, not on `SqlClient`**, and expose intent-named methods with a single tagged error type per repository (mapping both `EffectDrizzleQueryError` and `SqlError` into it). Callers `Effect.catchTag` on the repo error; the original `cause` stays available for logging (Drizzle's error already carries `query` and `params`). Prefer `Schema.TaggedError` over `Data.TaggedError` so errors are serialisable across RPC/HTTP boundaries.
- **Never call `db.transaction` on D1.** Put every multi-statement invariant behind `atomically(...)` (a `D1Client.batch`). Batches can read as well as write (results are returned per statement), but statements cannot depend on each other's results; compute ids client-side (ULIDs) or use `INSERT ... RETURNING` in a single statement. If a workload genuinely needs interactive transactions, that data belongs in a Durable Object's SQLite (`@effect/sql-sqlite-do` + `drizzle-orm/effect-sqlite-do`, which does support `transaction`), not in D1.
- **Keep repositories pure Drizzle**; reach for `sql` (tagged-template, same client) only for SQLite features Drizzle cannot express. Both paths share the prepared-statement cache and tracing (`sql.execute` spans, `db.system.name = sqlite`).
- **Tests:** `D1Client.layer({ db })` accepts any object implementing `D1Database`; a miniflare/`@cloudflare/vitest-pool-workers` binding or an in-memory stub (as in the smoke test) is enough to run repositories without a deployed database.

## Unverified / open

- Whether a plain `drizzle-orm@1.0.0-rc.5` (non-hashed) will keep the `effect-d1` API unchanged; only the hashed rc5 builds were checked. The `rc5` dist-tag moved from `-ab785fc` to `-169397b`; only `-ab785fc` was executed here.
- Alchemy's stated breakage boundary ("effect >= 4.0.0-rc.110") versus the observed removal of `Schema.TaggedErrorClass` in `4.0.0-beta.104`; irrelevant for rc.112 but noted.
- Whether `SqlError.classifySqliteError` matches D1's error message format.
- Behaviour of the hand-rolled `Layer.unwrap`-based `D1Live` inside Alchemy's Worker lifecycle (Alchemy's `SQL.D1Layer`/`Drizzle.D1` are the documented, execution-scoped path).
- `effect/unstable/sql/Migrator` on D1 was not tested; not needed with deploy-time migrations.
- Local dev: Alchemy docs state `alchemy dev` runs migrations against miniflare's local D1 (`Database.ts` local reconcile path); not run here.
