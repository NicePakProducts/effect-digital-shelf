# Develop and deploy the server

`apps/server` composes one Worker per stage: the API, Better Auth, the
one-minute cron, and the Scrape and Extraction Workflows. `alchemy.run.ts`
declares its Hyperdrive connection, R2 bucket and AI Gateway through infra.
Only `dev` and `prod` are accepted. Always supply the stage when deploying.

## Local development

Run `pnpm install --frozen-lockfile`, then `pnpm dev` from the repository root.
The dev script supplies `--stage dev --env-file .env.dev`. Stage credentials
live in gitignored `.env.<stage>` files; `scripts/provision-stage.sh` writes
the local file and the matching GitHub environment (`dev` or `prod`).
The Worker and gateway exporters use the same `AXIOM_DOMAIN` and `AXIOM_TOKEN`
values; deployment declares the gateway's OTel configuration automatically.

Under `alchemy dev`, Browser Rendering drives local headless Chrome. This
composition leaves it local; `Alchemy.remote()` is the explicit opt-in for
the cloud browser when a separately authorised smoke needs it. Local browser
success does not prove the deployed browser binding. Hyperdrive's dev origin
points directly at the stage database, so the dev server uses real dev data.
Auth's configured base URL is the stage host; a localhost session needs an
intentional local `AUTH_BASE_URL` override. Follow the URL printed by Alchemy.

API handlers, cron ticks and individual Workflow steps each build their own
database pool and telemetry exporters. Request resources close in Alchemy's
`ctx.waitUntil` after the response; cron and Workflow steps await scope closure
and telemetry flushing inline. Keep those lifetimes when adding entrypoints.
Put new core config keys in `apps/server/src/ConfigKeys.ts`: reads during Worker init
register secrets with Alchemy, even for `Config.string`. Missing optional
keys are skipped; core then applies its defaults at runtime. Provider retry
keys are also covered, including those assembled from a prefix.

## Schema changes and deployment

Generate a migration in the infra workspace:

```sh
pnpm --filter @digital-shelf/infra db:generate --name <change>
```

Commit Drizzle Kit's generated `migration.sql` and `snapshot.json`. Migrations
are append-only: preserve the initial migration, generate a new one for each
schema change, and never hand-edit either generated file.

For a local deploy, apply pending migrations over the stage's **direct**
`DATABASE_URL`, then deploy. Export the stage file's variables into the shell
for the migration process; Alchemy loads its own stage file for deployment:

```sh
set -a; . ./.env.dev; set +a; pnpm db:migrate
CI=true pnpm run deploy --stage dev --env-file .env.dev --yes
scripts/smoke.sh https://shelf-dev.apps.npbrands.au
```

`pnpm db:migrate` is the equivalent migration command when `DATABASE_URL`
is already exported. Never run migrations through Hyperdrive. Use `.env.prod`
and `--stage prod` for an authorised local production deploy. `CI=true` selects
noninteractive authentication; `--yes` accepts the deployment and state-store
bootstrap/upgrade. Cloudflare state uses an account-level state Worker and
Secrets Store; the provisioned token includes the needed permissions.

`SERVER_HOSTNAME`, when present, attaches a custom domain on `npbrands.au`, so
it must be a hostname in that zone: a `workers.dev` value fails the deploy.
Dev uses `shelf-dev.apps.npbrands.au`; prod uses `shelf.apps.npbrands.au` since
the cutover on 2026-09-11, with `AUTH_BASE_URL` aligned to the same host. The
stable `workers.dev` URL remains enabled.

## GitHub deployment

`.github/workflows/ci.yml` stays verification-only, including its disposable
Postgres service. `.github/workflows/deploy.yml` deploys dev on pushes to
`main`; manually dispatching that workflow deploys prod. Each job selects
the matching GitHub environment, installs the lockfile, runs `pnpm db:migrate`
with the environment's database secret, then deploys with `CI=true` and
`--stage <stage> --yes`. It supplies environment secrets and variables directly,
without an env file. Deployments are serialised per stage and have a 30-minute
timeout; an in-progress migration/deploy is not cancelled by a later push.

The exact secrets/variables split is in the deploy workflow and provisioner.
Optional `SCRAPPEY_ENDPOINT` and `EXTRACTION_MODEL` overrides fall back to
core's defaults because the wizard does not provision them.

When `AXIOM_DOMAIN` and `AXIOM_TOKEN` are set, the Worker exports traces and
logs to Axiom over OTLP. Each invocation builds an exporter and flushes it
when its Scope closes; each Workflow step builds and flushes its own exporter
inside the step, so buffered spans need not survive hibernation.
`packages/infra/src/Resources/AiGateway.ts` declares the gateway's
OTel exporter from the same values, including on updates. Both stages share
`digital-shelf-traces` and `digital-shelf-logs`; the Worker's
`deployment.environment.name` resource attribute identifies its stage.
Production stack evaluation fails if either Axiom value is absent, before
declaring resources. Dev warns and declares an empty exporter list, which
clears any existing gateway exporter, including one configured by hand.
The gateway exporter needs no dashboard step; deployment applies the declared
configuration on every update. After a deploy that first writes the exporter,
probe it: send one request through the gateway with a `cf-aig-otel-trace-id`
header and look for a `service.name == 'ai-gateway'` span in Axiom. On the
first dev deploy of #40 the written configuration was correct (verified by
GET) yet exported nothing for over ten minutes; re-applying the identical
configuration (`pnpm run deploy --stage <stage> --yes --force`) made spans
arrive within seconds. Repeat that if a probe stays silent.

Cloudflare's Worker observability is disabled; Axiom retains the exported
traces and logs. Logs written outside a telemetry region, including the
init-time "Axiom telemetry disabled" warning, reach only `wrangler tail`.
A stage running without the Axiom values retains no Worker logs.

**Verify in Axiom.** After an authorised deploy and Scrape, query its ID, for
example:

```sh
axiom query -D "<your axiom CLI login>" -O npbrands-etkr --start-time -2h "['digital-shelf-traces'] | where ['attributes.custom']['shelf.scrape.id'] == '<id>'"
```

Axiom stores span attributes in the `attributes.custom` map, verified against
the deployed dev trace. Access keys within that map as shown above; the dotted
field form is invalid. Tick per-phase counts use the same map, for example
`['attributes.custom']['shelf.tick.cadenceDue.started']`.
Check `digital-shelf-logs` for the same stage and invocation.

## Smoke and diagnosis

`scripts/smoke.sh <base-url>` exits nonzero unless all three checks pass:

```sh
curl --fail https://<host>/health
curl --fail https://<host>/api/docs
curl --silent --output /dev/null --write-out '%{http_code}\n' https://<host>/api/v1/brands
```

Health must return `{ "ok": true, "stage": "dev", "db": "ok" }` (or `prod`)
after a `select 1` through the invocation's Hyperdrive-backed Db. Docs must
serve Scalar; the unauthenticated brands endpoint must return `401`.
The script requires Bash, curl and the repository's supported Node version.

These checks do not launch a Scrape. During deploy review, also trigger an
authorised basic-mode Scrape through the API and follow its Scrape and
Extraction records to exercise Browser Rendering, R2 and both Workflows.
Unexpected platform failures run a compensating `fail` step; provider outcomes
and transition rules remain in core. Rejected transitions stop the Workflow
without compensation; successful transition replays are handled by core.

The standalone research projects remain on their research branches:

- [Hyperdrive/Postgres smoke](https://github.com/NicePakProducts/effect-digital-shelf/tree/research/drizzle-effect-postgres-hyperdrive/docs/research)
- [Playwright inside a Workflow](https://github.com/NicePakProducts/effect-digital-shelf/blob/research/playwright-browser-workflow/docs/research/playwright-browser-workflow.md)

The Node-import regression protects deployment-time module evaluation, where
a static Playwright import would fail. It does not replace deployed binding
smokes. Run the repository's checks and tests before deployment; real-Postgres
tests use only `DIGITAL_SHELF_TEST_POSTGRES_URL` against a disposable server,
never the stage's database.
