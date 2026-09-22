# Explicit packages and feature-owned persistence

The approved E1–E12 architecture separates shared application schemas, persistence, business capabilities, HTTP contracts, HTTP execution and browser bindings into explicit packages. The trade-off is more package configuration and explicit entity codecs in exchange for an install/import boundary that keeps persistence and server implementations out of browser contracts, and a feature layout where persistence ownership is discoverable without reading entrypoint wiring. Production fields, errors, routes, PostgreSQL driver, constraints and invocation lifetime are unchanged.

## Superseded decisions

This decision supersedes ADR 0002's table-derived application schemas in domain, ADR 0003's area layout and core Layers assembly, ADR 0005's combined api package, ADR 0006's Db/migration location and old app package name, and ADR 0008's class-static spelling, selective layerNoDeps and entrypoint-only peer provisioning. ADR 0009's private dependency-bearing service rule remains; its paths and peer wiring follow this decision. Those ADRs retain their historical rationale, including the alternatives previously rejected. The operator now explicitly chooses those package boundaries and default peer layers. ADR 0010's isolate graph and invocation-scoped connections remain authoritative.

## Package graph

Arrows below name production workspace dependencies; manifests are the source of truth for exports and external dependencies.

- schema → Effect only; explicit transport-neutral codecs, commands and errors.
- db → schema; root Db contract, separate invocation adapter, tables, Drizzle registry/config and append-only migrations. No core dependency even for tests.
- core → db, schema; public capabilities and private repositories.
- protocol → schema; HttpApi, wire projections and auth declarations.
- server → core, protocol, schema; handlers and auth mounts. Http.layer provides handlers/middleware, never business defaults.
- client → protocol, schema; generated ForApi client, AtomHttpApi and browser auth seam.
- infra → core, db, schema; resources and non-DB adapters. The InstantDB→Postgres/R2 importer stays here because it spans core rules and non-database resources.
- server-app (`apps/server`) → server, core, db, infra, schema; one Worker with HTTP, cron and both Workflows.
- web → client (schema is also an allowed direct boundary); never server, core or db.

Test-only exports are explicit and production source cannot import them. Server's generated-client integration test has a client devDependency; this does not reverse the production graph. Application dependencies remain pinned. There are no old api/domain compatibility packages or wildcard source exports.

## Feature and transaction ownership

Each public capability exports a namespace, Interface, Service, stable layerNoDeps and stable layer. The default supplies its repositories/private helpers and public peers; app composition flat-merges these defaults. Ports such as R2Bucket and Executions have no invented core implementation. Repositories capture Db once, decode stored rows and never open a transaction; features interpret absence, enforce rules and own transactions. Public method environments are closed.

Products and ProductVariants are one implementation boundary: ProductVariants uses ProductsRepo and VariantsRepo, not Products.Service. Listings uses public Products/ProductVariants operations for business validation. Scrapes, nested Extractions, runners, private Parents/Transitions and Sweeps share the explicitly enumerated lifecycle implementation boundary; Cron is an external public orchestrator. Merely nesting a new file grants no private access.

One stable adapter layer supplies Db to the combined graph; repeated stable layers memoize within that graph, not process-wide across independent builds. The captured Db contract resolves the transaction/invocation connection when a query runs. It does not capture an isolate socket. Workflow steps remain separate invocations. Config/provider setup failures remain in layer E, operational failures in method E.

Variant creation retains its preliminary Product lookup and the authoritative FK. Only PostgreSQL constraint `variants_product_id_products_id_fkey` with SQLSTATE 23503 becomes private ParentMissing and then public ProductNotFound. Other foreign keys, unique and check constraints retain SqlError and its diagnostic cause. Writes and row decoding gain no retries.

## Narrow SQL exceptions

`core/test/Boundaries.test.ts` enumerates exact repository consumers, imported table sets and owned write tables. The following read projections deliberately retain joins rather than becoming N+1 service calls:

- `listings/repository.ts`: withStatus/readStatus/findWithStatus/listWithStatus plus batched coverage. Product/Brand/Retailer pause, latest Scrape/Extraction and ordered Variant coverage belong to the Listing presentation. Writes only listings/listingVariants.
- `pages/repository.ts`: the corresponding Page status/pause/latest Scrape/Extraction projection. Writes only pages.
- `retailers/repository.ts`: listingUrls/pageUrls read ordered `{id,url}` children for the domain-change invariant. This avoids a Retailers↔Listings/Pages service cycle. Retailer FOR UPDATE and callers' public getForShare preserve lock ordering. Writes only retailers.
- `cascade/repository.ts`: impact/scrapeIds/subtree predicates collect descendant counts and object keys. Read-only; the caller delete and collection share a transaction, R2 cleanup follows commit.
- `scrapes/parents/repository.ts`: findTarget/cadenceDue/bulkCandidates own dispatch snapshots, pause/defaults and bounded due queries. Read-only; container existence and last-scraped writes use public capabilities.
- `scrapes/extractions/repository.ts`: latest extracted data/provenance, bulk eligibility and lifecycle joins. Listing/Page access is read-only, writes only extractions; ordinary Retailer prompt lookup uses Retailers.get.
- `auth/adapter.ts`: Better Auth's foreign transaction/invocation bridge can import only the auth table registry, not Catalog tables.

Db table definitions may reference each other for FKs and discovery. The app's health route uses Db only for `select 1`, not business tables. Infra's cutover importer is a separately operated cross-resource tool, not a production source dependency or a core repository. Neither exception grants handlers/apps private repositories or general table access.

## Verification and limitations

Db SchemaParity tests compare all entity select/insert/update codecs, including order, omission/null/Option/date transforms and re-encoding, against Drizzle-derived references and real migrated rows. Migration history moved byte-for-byte; generation must remain a no-op for this refactor. The original OpenAPI golden remains unchanged.

Layer tests prove construction requirements, closed method environments, one Db construction in a combined graph, isolated independent builds, and transaction rollback on pooled PostgreSQL. ProductVariants' real PostgreSQL test observes the INSERT blocked behind a Product deletion, then checks ProductNotFound after commit; unrelated constraints remain SqlError. E12's repository-substitution example is intentionally replaced with layerNoDeps over real repositories/Db, preserving the stronger project prohibition on repository fakes.

`PackageBoundaries.test.ts` resolves explicit exports, relative paths, re-exports, literal dynamic imports and root/workspace TS paths before checking dependencies. It checks every source edge and the transitive browser workspace graph; rejection fixtures exercise bypass attempts. Core separately enforces exact private persistence/table ownership. These are bounded source checks, not an arbitrary JavaScript evaluator: review still checks computed imports, local alias indirection, aliased SQL writes and third-party bundler behavior. The production web build and Node Worker/Workflow init-import tests complement them.

Run serial workspace checks/tests with at most two test workers and no file parallelism for PostgreSQL fixtures. A skipped overlap test is not evidence: CI supplies disposable PostgreSQL; local proof uses a newly initialized throwaway cluster, never a project database. The pinned Effect compiler may emit warning/suggestion diagnostics and exit nonzero during declaration builds; that result must be reported as nonzero, not hidden or relabeled a successful build.
