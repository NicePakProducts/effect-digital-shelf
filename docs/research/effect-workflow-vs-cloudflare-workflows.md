# Effect Workflow engine versus Cloudflare Workflows for Scrape and Extraction execution

Research ticket: [#19](https://github.com/NicePakProducts/effect-digital-shelf/issues/19) (part of [#1](https://github.com/NicePakProducts/effect-digital-shelf/issues/1)).
Researched 2026-09-09.

## TL;DR

**Stay on Cloudflare Workflows, with each lifecycle written as plain Effect functions behind a thin `Cloudflare.Workflows.task` adapter.** Nothing on the map changes.

- `effect@4.0.0-rc.112` ships exactly two `WorkflowEngine` implementations: an in-memory one that is documented as "not suitable for production", and `ClusterWorkflowEngine`, which needs the whole `unstable/cluster` runtime (`Sharding` + `MessageStorage`), and that runtime needs a SQL client **with transactions**. `@effect/sql-d1` dies on transactions, so **the cluster engine cannot run on D1**. The only Workers-shaped SQL client that satisfies it is `@effect/sql-sqlite-do` inside a Durable Object, and nobody (Effect, Alchemy) has built or documented a Durable-Object-hosted runner.
- `alchemy@2.0.0-beta.67` and `@latest` (`2.0.0-beta.76`) contain **zero references** to `effect/unstable/workflow` or `effect/unstable/cluster`. Alchemy's `Cloudflare.Workflows` module is a thin Effect wrapper over the native `WorkflowEntrypoint` / `step.do`; it is not a bridge.
- Replay semantics are the same shape on both sides (body re-runs from the top, named units are cached by name + attempt/count). Effect's `Activity` is typed and persists failures too; Cloudflare's `step.do` has engine-managed retries, per-attempt timeouts and a 1 MiB result cap.
- Instance identity: Effect derives the execution id from `tag + idempotencyKey(payload)` and **joins** a repeated `execute` to the existing execution instead of failing; its `poll` cannot distinguish "never started" from "running". Cloudflare `create` **throws** on a duplicate id and `get(id).status()` returns the exact `queued | running | waiting | paused | waitingForPause | complete | errored | terminated` set that `CONTEXT.md` already defines as **Execution status**. The Dispatch outcomes (`already-active`, `recovered-failed`) map directly onto Cloudflare and only awkwardly onto Effect.
- Cost: Cloudflare Workflows bills requests, CPU, storage and (from 2026-08-10) steps, with 500k steps/month included on Paid. A self-hosted cluster on Durable Objects would bill DO requests, duration, SQLite rows and alarms, plus four cluster tables and several polling loops that you operate yourself.
- Testing decision (#15) is unaffected by the recommendation; adopting Effect's engine would have replaced "lifecycles never spin the workflow runtime" with "lifecycles are `Workflow`/`Activity` definitions tested on `WorkflowEngine.layerMemory`".

## Versions under study

- `effect@4.0.0-rc.112` from `.repos/effect` (tag `effect@4.0.0-rc.112`, commit `2600f62`, see [`.repos/README.md`](../../.repos/README.md)). Package exports `./unstable/workflow` and `./unstable/cluster` ([`packages/effect/package.json`](../../.repos/effect/packages/effect/package.json) lines 35 and 49). npm dist-tags on 2026-09-09: `effect` `rc: 4.0.0-rc.112`, `latest: 3.22.1`; `@effect/sql-d1` and `@effect/sql-sqlite-do` both publish `rc: 4.0.0-rc.112` (`npm view <pkg> dist-tags`).
- `alchemy@2.0.0-beta.67` (slopcop's pin) and `alchemy@2.0.0-beta.76` (`latest` on 2026-09-09; `next` is `beta.72`), inspected from the registry tarballs (`npm pack`).
- Cloudflare docs fetched 2026-09-09 as the official Markdown variants (`<page>/index.md`) because the WebFetch summariser was unavailable; every URL is listed under [Sources](#sources).

## 1. What Effect rc.112 actually ships, and what it needs to run

### 1.1 The workflow module

`effect/unstable/workflow` is engine-agnostic. It defines:

- `Workflow.make(tag, { payload, idempotencyKey, success?, error?, suspendedRetrySchedule?, annotations? })` — a typed definition with `execute`, `poll`, `interrupt`, `resume`, `toLayer`, `executionId` and `withCompensation` ([`Workflow.ts`](../../.repos/effect/packages/effect/src/unstable/workflow/Workflow.ts) lines 40-176, constructor at 429-463).
- `Activity.make({ name, success?, error?, execute, interruptRetryPolicy? })` — an `Effect` with a stable name whose `Exit` is encoded through JSON codecs so the engine can store and replay it ([`Activity.ts`](../../.repos/effect/packages/effect/src/unstable/workflow/Activity.ts) lines 123-178).
- `DurableClock` (durable sleeps), `DurableDeferred` (named wait points completed from outside), `DurableQueue` (persisted background workers; needs `unstable/persistence/PersistedQueue`), `WorkflowProxy`/`WorkflowProxyServer` (expose workflows as RPC/HttpApi).
- `WorkflowEngine` — the service every one of the above needs. Its contract is `register`, `execute`, `poll`, `interrupt`, `interruptUnsafe`, `resume`, `activityExecute`, `deferredResult`, `deferredDone`, `scheduleClock` ([`WorkflowEngine.ts`](../../.repos/effect/packages/effect/src/unstable/workflow/WorkflowEngine.ts) lines 37-207). A low-level `Encoded` contract (lines 384-430) plus `makeUnsafe` (447) is the extension point for a custom engine.

### 1.2 The two engines that exist

| Engine | Where | Storage | Runtime it needs | Production? |
| --- | --- | --- | --- | --- |
| `WorkflowEngine.layerMemory` | `WorkflowEngine.ts` 663-855 | JS `Map`s in the layer's scope | none | No. Doc comment: "This layer keeps state only in memory and is not suitable for production workflows that require durability" (lines 651-662). |
| `ClusterWorkflowEngine.layer` | [`ClusterWorkflowEngine.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts) 800-806 | `MessageStorage` (cluster mailbox) | `Sharding.Sharding` + `MessageStorage` | Yes, this is the durable one. |

There is no third engine in the tree. `grep -rli "cloudflare|durable object|D1Database|workerd"` over `src/unstable/workflow` and `src/unstable/cluster` returns nothing.

### 1.3 How the cluster engine persists a workflow

Every workflow becomes a cluster `Entity` named `Workflow/<tag>` whose entity id is the execution id, with four RPCs: `run` (primary key `""`), `activity` (primary key `` `${name}/${attempt}` ``), `deferred` (primary key = deferred name) and `resume`, all annotated `ClusterSchema.Persisted` (lines 675-759). Durable clocks are a fifth entity `Workflow/-/DurableClock` whose message carries a `DeliverAt` wake-up time (745-777). Persisted requests are saved to `MessageStorage`; a save whose primary key already exists comes back as `SaveResult.Duplicate` carrying the last stored reply ([`MessageStorage.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/MessageStorage.ts) 600-625), and the runner then answers from that reply instead of re-executing ([`Runners.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/Runners.ts) 207-238). That is the replay mechanism.

Entities for workflows are released after ten seconds idle; "Their state is durable, so an evicted execution is rebuilt from storage when its next message arrives" ([`.changeset/pre/wild-donuts-brake.md`](../../.repos/effect/.changeset/pre/wild-donuts-brake.md); `entityMaxIdleTime` at `ClusterWorkflowEngine.ts` 710).

### 1.4 What `Sharding` needs

`Sharding.layer` requires `ShardingConfig | Runners | MessageStorage | RunnerStorage | RunnerHealth` ([`Sharding.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/Sharding.ts) 1776-1782). The pre-assembled runners are:

| Runner layer | Transport | Storage | Intended host |
| --- | --- | --- | --- |
| `TestRunner.layer` | `Runners.layerNoop` | `MessageStorage.layerMemory` + `RunnerStorage.layerMemory` | tests only ([`TestRunner.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/TestRunner.ts) 31-39) |
| `SingleRunner.layer` | `Runners.layerNoop` | `SqlMessageStorage.layer` + `SqlRunnerStorage.layer` (or memory runner storage) | "local, embedded, or small single-node setups"; "It still requires a SQL client because mailbox messages and replies are stored in SQL" ([`SingleRunner.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/SingleRunner.ts) 1-77). Requires `SqlClient | Crypto.Crypto`. |
| `HttpRunner.layerHttp` / `layerWebsocket` | HTTP or WebSocket RPC between runners | SQL | multi-node, long-lived servers ([`HttpRunner.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/HttpRunner.ts) 276-370) |
| `SocketRunner.layer` | socket server | SQL | multi-node ([`SocketRunner.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/SocketRunner.ts) 65-80) |
| `RunnerHealth.layerK8s` | Kubernetes API | — | k8s pods ([`RunnerHealth.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/RunnerHealth.ts) 105-145) |

The runtime is built around a long-lived process: `Sharding.make` forks fibers that run `Effect.forever` on `entityMessagePollInterval` (default 10 s), refresh shard locks every `shardLockRefreshInterval` (10 s, expiry 35 s), refresh assignments every 3 s and health-check runners every minute (`Sharding.ts` 466-472, 558-570, 863-876, 1299-1309; defaults at [`ShardingConfig.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/ShardingConfig.ts) 176-199). `SingleRunner` loads its config with `ShardingConfig.layerFromEnv` (382).

### 1.5 SQL storage: dialects, tables, transactions

`SqlMessageStorage` and `SqlRunnerStorage` branch on `sql.onDialectOrElse` for `pg`, `mysql`, `mssql` and fall through to SQLite ([`SqlMessageStorage.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/SqlMessageStorage.ts) 110-116, 197-199, 285-306, 370-372; tables `cluster_messages` and `cluster_replies` created at 839-1090, SQLite variant 918-946; [`SqlRunnerStorage.ts`](../../.repos/effect/packages/effect/src/unstable/cluster/SqlRunnerStorage.ts) creates `cluster_runners` and `cluster_locks`, SQLite variant 238-291, with row-based locks where advisory locks are unavailable, header lines 1-7). So a SQLite dialect is supported in principle.

The blocker is transactions. `SqlMessageStorage` wraps saves, reply writes, claims and resets in `sql.withTransaction` (lines 347, 483, 519, 568, 586, 730, 748-751), and exposes `withTransaction` to the engine for `WithTransaction`-annotated activities. Both Workers SQL clients in the same monorepo:

- **`@effect/sql-d1`**: `const transactionAcquirer = Effect.die("transactions are not supported in D1")` ([`D1Client.ts`](../../.repos/effect/packages/sql/d1/src/D1Client.ts) 317; header at 193: "transactions and streaming queries are not supported by this driver"). This is the same limitation research #3 already recorded for Drizzle. **`SqlMessageStorage` on D1 therefore dies on its first save.**
- **`@effect/sql-sqlite-do`**: adapts a Durable Object `SqlStorage` handle; transactions work only "when `withTransaction` or migrations need Cloudflare-managed transactions" and you pass `ctx.storage` ([`SqliteClient.ts`](../../.repos/effect/packages/sql/sqlite-do/src/SqliteClient.ts) 1-21, 296-306). Its tests run against a fake `SqlStorage` under plain vitest, not workerd ([`test/Client.test.ts`](../../.repos/effect/packages/sql/sqlite-do/test/Client.test.ts) 1-25).

The cluster engine's own test suite uses `MessageStorage.layerMemory` + `RunnerStorage.layerMemory` ([`test/cluster/ClusterWorkflowEngine.test.ts`](../../.repos/effect/packages/effect/test/cluster/ClusterWorkflowEngine.test.ts) 744-745); there is no SQLite, D1 or Durable Object test of the engine anywhere in the repo.

### 1.6 Can it run inside a Worker today?

- **Worker + D1: no.** Transactions die (above).
- **Worker isolate + anything: no.** The runtime needs resident polling fibers, shard-lock refreshes and an entity cache that survive between events. An HTTP-triggered Worker can run "as long as the client remains connected"; after the response "`waitUntil()` can extend execution for up to 30 seconds"; cron invocations are capped at 15 minutes wall time ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/), "Duration"). There is nowhere for a 10-second poll loop to live.
- **Durable Object + `@effect/sql-sqlite-do`: conceivable, unbuilt.** A single DO could host `SingleRunner.layer` over `ctx.storage` (transactions available) and be kept alive by alarms: "Each Durable Object is able to schedule a single alarm at a time", alarms have "guaranteed at-least-once execution" with "up to 6 retries", and an alarm handler has a 15-minute wall-time limit ([Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/); [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) "Wall time limits by invocation type"). But a DO "remains alive for several seconds after being idle before hibernating" and "In-memory state is reset when the Durable Object hibernates" ([What are Durable Objects](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)), so the whole `Sharding` layer (locks, snowflake generator, entity cache, latches) would be rebuilt on every wake, its polling loops replaced by alarm-driven `sharding.pollStorage` calls, and the DO's 30 s CPU budget per request ("configurable to 5 minutes") would have to cover the workflow bodies themselves, since activities execute inside the entity that owns the shard (`ClusterWorkflowEngine.ts` 394-425: the `activity` RPC handler waits on an in-process latch for the activity registered by the running body at 514-555). That is a research project, not an adapter, and it re-implements what Cloudflare Workflows already does.
- **Alchemy bridge: none.** Grepping `src/` of both `alchemy@2.0.0-beta.67` and `@2.0.0-beta.76` for `WorkflowEngine`, `unstable/workflow`, `unstable/cluster`, `ClusterWorkflowEngine`, `MessageStorage`, `RunnerStorage`, `DurableDeferred`, `DurableClock`, `Activity.make`, `Workflow.make` yields zero hits; the only `effect/unstable/*` imports are `ai, cli, encoding, http, httpapi, observability, persistence, process, rpc, socket, sql`. beta.76 adds `@effect/sql-sqlite-do` as a dependency, used by `src/Drizzle/Cloudflare.ts` for Durable Object SQL, not by anything workflow-related. Alchemy's own `Cloudflare.Workflows` wraps native `step.do` (see §2.2).
- **A custom `WorkflowEngine` over Cloudflare Workflows**: the `Encoded` contract is small enough to imagine `activityExecute` → `step.do`, `scheduleClock` → `step.sleep`, `deferredResult`/`deferredDone` → `waitForEvent`/`sendEvent`. Nobody has built it, the `step` handle only exists inside `run()`, and it would buy typed activities at the cost of owning an engine. Listed under Unverified; not recommended.

## 2. Durability and replay: `Activity` versus `step.do`

### 2.1 Effect `Activity`

- **Cache key**: `` `${executionId}/${activity.name}/${attempt}` `` in memory (`WorkflowEngine.ts` 795); `` `${name}/${attempt}` `` as the persisted primary key per workflow entity in the cluster engine (`ClusterWorkflowEngine.ts` 743). `attempt` comes from `Activity.CurrentAttempt`, incremented by `Activity.retry` (`Activity.ts` 210-241). Each retry attempt is therefore a separately persisted result; there is no engine-level retry config, you write `Activity.retry(activity, { times })` or `Effect.retry` yourself, and timeouts are `Effect.timeout` inside the activity.
- **What is stored**: the encoded `Exit` including failures and (by default) defects. `Workflow.intoResult` turns any failure into `Complete({ exit: failCause })` unless `CaptureDefects` is `false` (`Workflow.ts` 656-717, 876-889). The memory engine stores `state.exit` whatever it is and returns it on the next call (`WorkflowEngine.ts` 798-815). A **failed activity is replayed as failed**; only a `Suspended` result is re-executed.
- **Replay model**: on resume the engine re-invokes the registered body from the top (`resume` re-runs `state.execute` at `WorkflowEngine.ts` 696-737; the cluster engine resets and redelivers the persisted `run` request at `ClusterWorkflowEngine.ts` 273-283). Code outside activities runs again; activities whose key already has a stored exit return it.
- **Suspension**: `DurableDeferred.await` and `DurableClock.sleep` set `instance.suspended`, interrupt the run fiber, store `Suspended`, and the caller's `execute` re-polls on `suspendedRetrySchedule` (`Workflow.ts` 859-868; `WorkflowEngine.ts` 496-540). Sleeps at or below `inMemoryThreshold` run as an in-memory activity; longer ones go through `scheduleClock` ([`DurableClock.ts`](../../.repos/effect/packages/effect/src/unstable/workflow/DurableClock.ts) 60-117).
- **Interruption**: an activity interrupted mid-flight (shutdown, shard move) is retried up to 10 times with exponential backoff before dying (`Activity.ts` 181-206).
- **Compensation**: `Workflow.withCompensation` registers a finalizer on the workflow scope that runs if the whole workflow fails (`Workflow.ts` 831-857).
- **Result size**: no documented cap; whatever the SQL `payload TEXT` column holds.

### 2.2 Cloudflare `step.do` (and Alchemy's `task`)

- **Cache key**: the step name plus a 1-indexed `count` for repeated names: "Step names act as the 'cache key' in your Workflow" ([Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)); `WorkflowStepContext` exposes `step.name`, `step.count`, `attempt` ([Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)).
- **Retries and timeout are engine config**: default `retries: { limit: 5, delay: 10000, backoff: "exponential" }, timeout: "10 minutes"`, up to 10,000 retries, timeout "set per attempt" ([Sleeping and retrying](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)). `NonRetryableError` "stops step retries, propagating the error to the top level".
- **What is stored**: only successful returns ("Any structured-cloneable type ... no longer than 1 MB"; the limits page says 1 MiB). A step that exhausts retries fails the instance; there is no "replay the failure" state.
- **Replay model**: "If the engine restarts, the step logic will be preserved, but logic outside of the steps may be duplicated"; "you should not store state outside of a step"; conditionals "must be based on deterministic values" (Rules of Workflows). Same shape as Effect.
- **Sleeps and events**: `step.sleep` up to 365 days and "do not count towards the maximum Workflow steps limit"; `step.waitForEvent` default timeout 24 h, max 365 days; events sent early are buffered ([Events and parameters](https://developers.cloudflare.com/workflows/build/events-and-parameters/)).
- **Alchemy's `task`** (`alchemy@2.0.0-beta.67` `src/Cloudflare/Workflows/Workflow.ts` 173-196; `WorkflowBridge.ts` 137-178): captures the enclosing Effect context, runs the effect with `Effect.runPromise` inside the `step.do` callback, forwards `{ retries, timeout }` and optional `rollback`, and picks one of the four `step.do` overloads. The effect's error channel is forced to `never`; a failure rejects the promise and Cloudflare retries it per config. `run(event, step)` gets a fresh `Scope` per invocation and re-runs the whole body on replay (`WorkflowBridge.ts` 77-122); the docs say "a completed task returns its persisted result — the effect inside is not re-run — while everything outside a task runs again from the top" ([alchemy.run Workflows guide](https://alchemy.run/cloudflare/compute/workflows/)). Instance handles: `create`/`createBatch`/`get` and `status`/`pause`/`resume`/`restart`/`terminate`/`sendEvent` are `Effect.tryPromise(...).pipe(Effect.orDie)` (`Workflow.ts` 811-831, 1007-1026; beta.76 892-906, 1109-1128), so **every binding error, including a duplicate id, surfaces as a defect**, not a typed error.

### 2.3 Side by side

| | Effect `Activity` on `ClusterWorkflowEngine` | Cloudflare `step.do` |
| --- | --- | --- |
| Unit identity | `name/attempt` | `name` + `count` |
| Retry | user-written (`Activity.retry`), each attempt persisted | engine config, default 5 × exponential |
| Timeout | user-written | engine config, per attempt |
| Failure replay | failure persisted and replayed | not persisted; instance errors |
| Typed errors | yes, schema on the activity | no; `task` forces `never`, Cloudflare sees thrown errors |
| Body re-run on restart | yes | yes |
| Sleep / external wait | `DurableClock` / `DurableDeferred` | `step.sleep` / `step.waitForEvent` |
| Result cap | none documented | 1 MiB non-stream |
| Compensation | `withCompensation` finalizer | `rollback` handler per step |

For a Scrape (fetch ≤ 180 s, store HTML in R2, mark row, spawn Extraction) and an Extraction (sanitise, one LLM call, store JSON), both models are equivalent. The one behavioural difference that matters is that Effect replays a *failed* activity as failed, which is harmless here because a failed Scrape "is followed by a new Scrape, never re-run" (`CONTEXT.md`, **Scrape**).

## 3. Instance identity: single-use ids and Dispatch / Reconcile

### 3.1 Effect

- The execution id is deterministic: `makeHashDigest(`${tag}-${idempotencyKey(payload)}`)` (SHA-256 via `crypto.subtle`, `Workflow.ts` 316-317, [`internal/crypto.ts`](../../.repos/effect/packages/effect/src/unstable/workflow/internal/crypto.ts) 6). `Workflow.executionId(payload)` computes it without executing; `execute(payload, { discard: true })` returns it ([`WorkflowEngine.test.ts`](../../.repos/effect/packages/effect/test/unstable/workflow/WorkflowEngine.test.ts) 49-75).
- A repeated `execute` with the same payload does not fail: the memory engine awaits the existing fiber (`WorkflowEngine.ts` 747-777) and the cluster engine's persisted `run` request (primary key `""`) is a `Duplicate` answered from the stored exit or attached to the in-flight run (`Runners.ts` 207-238). **There is no `already_exists`; the second caller joins the first.**
- `poll(executionId)` returns `Some(Complete)` when finished, `Some(Suspended)` when parked on a deferred/clock, and `None` both when the execution is running and when it never existed (`WorkflowEngine.ts` 819-833; `ClusterWorkflowEngine.ts` 471-484: "if no reply, `Option.none()`"). Distinguishing "active" from "nonexistent" needs `MessageStorage.requestIdForPrimaryKey` (`MessageStorage.ts` 102, 334), which is below the `WorkflowEngine` API.
- Single-use in the glossary sense ("once it has existed, it can never be started again under the same identity") holds trivially: the id *is* the payload hash, so a fresh Scrape row means a fresh id, and re-executing an old id returns the old result rather than re-running.

### 3.2 Cloudflare

- Ids are "automatically generated, but a user-provided ID can be specified (up to 100 characters)" and "Must be unique within the Workflow"; `create` "Throws an error if the provided ID is already used by an existing instance that has not yet passed its retention limit" ([Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)). "Workflow instance IDs are unique per Workflow ... even after completion" (Rules of Workflows). Retention is 3 days Free / 30 days Paid and configurable per instance via `retention` ([Limits](https://developers.cloudflare.com/workflows/reference/limits/)).
- `createBatch` is the idempotent form: "will not fail if an ID is already in use ... it will be skipped and excluded from the returned array" (up to 100 per call).
- `get(id)` "Throws an exception if the instance ID does not exist"; `status()` returns `queued | running | paused | errored | terminated | complete | waiting | waitingForPause | unknown`.
- The literal error code `instance.already_exists` is **not on any Cloudflare docs page fetched**. It is what the old app matched at runtime, together with the humanised "Instance already exists" ([`~/Cloudflare/browser-worker/backend/src/scrape/workflow-dispatcher.ts`](file:///home/vdelapena/Cloudflare/browser-worker/backend/src/scrape/workflow-dispatcher.ts) lines 1-10 and 152-160, which deliberately keep it as "the only place the `instance.already_exists` substring is referenced"). The new adapter must keep that one-line substring match, and because Alchemy's `create` is `orDie`, it must catch the **defect** (`Effect.catchDefect` / `Cause.squash`) rather than a typed error.

### 3.3 Mapping the glossary

| `CONTEXT.md` term | Cloudflare Workflows | Effect `ClusterWorkflowEngine` |
| --- | --- | --- |
| **Execution** id (single-use) | `create({ id: scrapeId })`; `already_exists` on reuse within retention | `executionId = hash(tag + scrapeId)`; reuse joins/returns cached |
| **Execution status** active / terminal | exactly the `InstanceStatus` union | `poll`: `None` (running *or* absent), `Some(Suspended)`, `Some(Complete)`; no `paused`/`queued`/`terminated` distinctions |
| **Dispatch** → `created` | `create` succeeds | `execute(..., { discard: true })` succeeds (also when it already existed) |
| → `already-active` | `create` throws `already_exists`, `get(id).status()` active | not observable through the public engine API (`poll` is `None` for both running and absent) |
| → `recovered-failed` | `create` throws, `status()` terminal → row `failed` | `poll` is `Some(Complete)` → row `failed`; but `execute` would have silently returned the old result first |
| **Orphan Execution** + **Reconcile** | `get(id).status()` | `poll(id)` for the terminal branch; active branch needs storage access |
| **Stuck Scrape** sweep | independent of the engine (row wall-clock) | same |

The glossary's Execution vocabulary was written against Cloudflare's status model and the `already_exists` refusal; Effect's engine has neither a refusal nor an active/absent distinction, so adopting it would mean rewriting **Dispatch outcome** and **Reconcile**.

## 4. Cost and operational surface

### 4.1 Cloudflare Workflows (managed)

- Billing dimensions: requests, CPU time, storage, steps. Paid: "10 million included per month + $0.30 per additional million" requests; "30 million CPU milliseconds included per month + $0.02 per additional million"; storage "1 GB included per month + $0.20/ GB-month"; steps "500,000 included per month + $0.80/ additional 100,000". Free: 100k requests/day, 10 ms CPU, 1 GB, 3,000 steps/day. "Billing for Workflows steps and storage will apply starting August 10th, 2026"; "Step count does not include rollback handlers or retries"; sleeping instances "do not incur CPU time" ([Pricing](https://developers.cloudflare.com/workflows/reference/pricing/)).
- Limits that matter here (Paid): 50,000 concurrent running instances, 2,000,000 queued, creation "300 per second per account, 100 per second per workflow" (HTTP 429 beyond), 10,000 steps per instance, 1 GB persisted state per instance, 30 s default CPU per step configurable to 5 min, unlimited wall time per step ([Limits](https://developers.cloudflare.com/workflows/reference/limits/)). Bulk triggers that create thousands of rows are drained by Cron (`CONTEXT.md`, **Bulk trigger**), so the per-workflow 100/s creation rate is the only limit the design must respect.
- Observability built in: `workflowsAdaptiveGroups` dataset with `workflowName, instanceId, stepName, eventType, stepCount` dimensions, 31-day retention ([Metrics](https://developers.cloudflare.com/workflows/observability/metrics-analytics/)); instance state and logs kept 3/30 days; `wrangler workflows instances describe|list|delete` and pause/resume/restart/terminate in local dev since 2026-03 ([Changelog](https://developers.cloudflare.com/workflows/reference/changelog/)).
- Operations you own: none beyond the Alchemy `Cloudflare.Workflow` resource (#4 confirmed first-class in beta.67).
- Rough sizing: a Scrape at ~4 steps and an Extraction at ~3 steps stays inside the 500k included steps up to roughly 70k Scrape+Extraction pairs a month before the $0.80/100k overage.

### 4.2 Effect cluster on a Durable Object (self-hosted, hypothetical)

- Billing: DO requests ("1 million / month, + $0.15/million"), duration ("400,000 GB-s / month, + $12.50/million GB-s", 128 MB billed while the object is active), SQLite rows read ("25 billion / month included + $0.001 / million") and written ("50 million / month included + $1.00 / million"), storage "5 GB-month, + $0.20/ GB-month", and "Each `setAlarm()` is billed as a single row written" ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)). Every activity is at least one `cluster_messages` insert plus a `cluster_replies` insert plus claim/processed updates, so row writes, not requests, dominate.
- Operations you own: four tables (`cluster_messages`, `cluster_replies`, `cluster_runners`, `cluster_locks`) with their indexes and growth (only chunk replies are deleted automatically, `SqlMessageStorage.ts` 576-578; see Unverified), the alarm-driven keep-alive, shard-lock timing tuned to DO hibernation, the 10 GB per-object SQLite ceiling ([DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)), CPU budget per request for the workflow bodies, tracing (the engine emits spans, but there is no dashboard), and every upgrade of an `unstable` module (the rc changesets show cluster fixes landing continuously: `fix-cluster-shutdown-deadlock`, `fix-cluster-strand-request-shutdown`, `fix-persisted-cluster-reply-hang`, `fix-memory-workflow-interrupt`, ...).
- Nothing about this is dramatically expensive at this product's scale; it is simply a second execution engine to operate for no functional gain.

## 5. Effect on the Testing decision (#15)

The map says: "lifecycles as plain functions never spinning the workflow runtime, `TestClock` for time".

- **Cloudflare + thin adapter (recommended)**: the lifecycle is `scrape.run(deps)(scrapeId)` composed of ordinary Effects; the adapter is the only place `Cloudflare.Workflows.task("fetch", ...)`, `sleep` and `create` appear, mirroring how the old app isolated `instance.already_exists` in one file. Unit tests run the functions with fake providers; the durable boundaries are exercised by an on-demand smoke via `alchemy dev` (local workflows engine in beta.76, `ProviderLocal`) or a deploy. The decision stands unchanged. One caveat for the adapter's own tests: `task` needs a `WorkflowStep` in context, so a test double for `WorkflowStep` (or leaving the adapter untested beyond the smoke) is required.
- **Effect engine**: the lifecycle would be `Workflow.make` + `Activity.make` definitions. They are still plain Effects, but they now require `WorkflowEngine` and `WorkflowInstance` in context, JSON-encodable success/error schemas on every activity, and tests would provide `WorkflowEngine.layerMemory` plus `TestClock` (exactly what the upstream tests do, `WorkflowEngine.test.ts` 49-75). That is a fast in-process engine, so it is not a bad testing story, but it replaces the "never spin the runtime" rule with "spin the in-memory engine", and it buys nothing at runtime because the durable engine cannot be deployed on this stack (§1.6).

## Recommendation

**Stay on Cloudflare Workflows.** Write each lifecycle as plain Effect functions in `core` and keep a single adapter in `infra` (or a `workflows` module of the Worker) that:

1. wraps the durable boundaries in `Cloudflare.Workflows.task(name, effect, { retries, timeout })` with deterministic step names (`fetch`, `store-html`, `mark-success`, `spawn-extraction`; `sanitise`, `extract`, `store-json`), passing the Scrape's 180 s budget as the fetch task's `timeout` and leaving retries off (the row, not the step, owns retry semantics);
2. creates instances with `create({ id: scrapeId | extractionId, params })`, catches the **defect** and matches the `instance.already_exists` / "Instance already exists" substring in one function, then consults `get(id).status()` to produce `already-active` or `recovered-failed`;
3. uses `createBatch` for **Bulk trigger** batches (idempotent, ≤ 100 per call), respecting the 100/s per-workflow creation limit.

**What changes on the map: nothing.** The Execution standing decision, the Execution-status vocabulary, the Dispatch outcomes and the Testing decision all stay as written. Two small notes for later tickets:

- "Observability" (Not yet specified) can lean on `workflowsAdaptiveGroups` and instance logs rather than custom tracing for the Workflows layer.
- "Retention and sweep sizing" should set the Workflows `retention` per instance (Paid default 30 days) so completed instances do not outlive the Scrape retention window and so ids become reusable no later than rows are deleted.

Revisit only if Effect ships a Workers/Durable-Object runner for `unstable/cluster` or Alchemy ships a `WorkflowEngine` over Cloudflare Workflows; neither exists in rc.112 or alchemy beta.76.

## Unverified

- No code was executed against workerd: "SqlMessageStorage dies on D1" is read from the source (`sql.withTransaction` calls and `D1Client`'s `Effect.die`), not observed at runtime.
- Whether `SingleRunner.layer` over `@effect/sql-sqlite-do` with `ctx.storage` boots at all inside a Durable Object (the `Sharding` layer's `Effect.forever` fibers, `Crypto.Crypto` and `ShardingConfig.layerFromEnv` under workerd) has not been tried by anyone I could find.
- Whether the cluster engine ever deletes completed `run`/`activity` rows from `cluster_messages`/`cluster_replies`; I found `clearReplies` (chunk replies only) and `clearAddress` (used for clocks) but no retention sweep for completed workflow rows.
- The exact wire shape of Cloudflare's duplicate-id error today (`instance.already_exists` vs "Instance already exists"). The docs only say "Throws an error"; the substring pair comes from the old app's runtime experience.
- Whether an instance id becomes reusable once the instance passes its retention limit or is deleted; the docs imply it ("has not yet passed its retention limit") but never state it.
- Feasibility of a custom `WorkflowEngine.makeUnsafe` over `step.do`/`waitForEvent`; sketched in §1.6, not attempted.
- `WebFetch` was unavailable this session; Cloudflare and alchemy.run pages were read via their Markdown variants with `curl`.

## Sources

Effect rc.112 (`.repos/effect`, tag `effect@4.0.0-rc.112`):

- `packages/effect/src/unstable/workflow/{Workflow,Activity,WorkflowEngine,DurableClock,DurableDeferred,DurableQueue}.ts`, `internal/crypto.ts`
- `packages/effect/src/unstable/cluster/{ClusterWorkflowEngine,Sharding,ShardingConfig,SingleRunner,TestRunner,HttpRunner,SocketRunner,RunnerHealth,MessageStorage,SqlMessageStorage,SqlRunnerStorage,Runners}.ts`
- `packages/sql/d1/src/D1Client.ts`, `packages/sql/sqlite-do/src/SqliteClient.ts`, `packages/sql/sqlite-do/test/Client.test.ts`
- `packages/effect/test/unstable/workflow/WorkflowEngine.test.ts`, `packages/effect/test/cluster/ClusterWorkflowEngine.test.ts`
- `.changeset/pre/wild-donuts-brake.md` and the other `fix-cluster-*` / `fix-workflow-*` changesets
- `packages/effect/package.json` (exports)

Alchemy (registry tarballs, `npm pack alchemy@2.0.0-beta.67` and `@2.0.0-beta.76`):

- `src/Cloudflare/Workflows/{Workflow,WorkflowBridge,WorkflowName}.ts`, `src/Cloudflare/index.ts`, `package.json`
- https://alchemy.run/cloudflare/compute/workflows/

Cloudflare docs (Markdown variants fetched 2026-09-09):

- https://developers.cloudflare.com/workflows/build/workers-api/
- https://developers.cloudflare.com/workflows/build/rules-of-workflows/
- https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
- https://developers.cloudflare.com/workflows/build/events-and-parameters/
- https://developers.cloudflare.com/workflows/build/trigger-workflows/
- https://developers.cloudflare.com/workflows/reference/limits/
- https://developers.cloudflare.com/workflows/reference/pricing/
- https://developers.cloudflare.com/workflows/reference/changelog/
- https://developers.cloudflare.com/workflows/observability/metrics-analytics/
- https://developers.cloudflare.com/durable-objects/api/alarms/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/platform/pricing/

Registry: `npm view effect dist-tags`, `npm view @effect/sql-d1 dist-tags`, `npm view @effect/sql-sqlite-do dist-tags`, `npm view alchemy dist-tags` (all 2026-09-09).

Prior work in this repo: [#3 Drizzle on D1](https://github.com/NicePakProducts/effect-digital-shelf/issues/3) (no D1 transactions), [#4 Alchemy resources](https://github.com/NicePakProducts/effect-digital-shelf/issues/4) (`docs/research/alchemy-cloudflare-resources.md` on branch `research/alchemy-cloudflare-resources`), [#15 Testing strategy](https://github.com/NicePakProducts/effect-digital-shelf/issues/15); old app `~/Cloudflare/browser-worker/backend/src/{scrape,extract}/workflow-dispatcher.ts`.
