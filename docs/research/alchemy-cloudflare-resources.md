# Alchemy (Effect edition) resources for Workflows, Browser Rendering, R2, AI Gateway and cron

Research ticket: [#4](https://github.com/NicePakProducts/effect-digital-shelf/issues/4) (part of [#1](https://github.com/NicePakProducts/effect-digital-shelf/issues/1)).
Researched 2026-09-08.

## TL;DR

Every resource the ticket asks about is a first-class citizen of `alchemy@2.0.0-beta.67` (the version slopcop pins). **No raw wrangler fallback is needed for any of them.** Each follows the same two-phase pattern slopcop already uses for D1 and Queues: `yield*` the binding in the Worker's init `Effect.gen`, provide the matching `*Binding` layer on the Worker effect, and the binding both registers the native Cloudflare binding at deploy time and resolves to an Effect-native client at runtime.

| Resource | Stack-level resource call | Worker-side binding (init phase) | Layer to `Effect.provide` | Runtime `env` type (async form) | Gap / fallback |
| --- | --- | --- | --- | --- | --- |
| Workflow class | `Cloudflare.Workflow<Self>()("Name", Effect.gen(...))` (class form) | `const wf = yield* MyWorkflow` inside `Cloudflare.Worker(...)` | none extra (the `Worker` service is already in scope) | `Workflow<Params>` via `env: { X: Cloudflare.Workflow("Name", { className }) }` | None. Alchemy emits the `WorkflowEntrypoint` class into the bundle and drives `putWorkflow`. |
| Browser Rendering | none (Worker-only binding, no cloud resource) | `const browser = yield* Cloudflare.Browser("BROWSER")` | `Cloudflare.Workers.BrowserBinding` | `BrowserRun` via `env: { BROWSER: Cloudflare.Browser() }` | None. Dev mode proxies to the real remote binding. |
| R2 bucket | `Cloudflare.R2.Bucket("Id", { name?, ... })` | `yield* Cloudflare.R2.ReadWriteBucket(Bucket)` (or `ReadBucket` / `WriteBucket`) | `Cloudflare.R2.ReadWriteBucketBinding` (or `Read…`/`Write…`) | `R2Bucket` via `env: { Bucket }` | None. `*BucketHttp` layers exist for non-Worker contexts. |
| Workers AI (plain) | none (Worker-only binding) | `const ai = yield* Cloudflare.Workers.AI()` | `Cloudflare.Workers.AIBinding` | `Ai` via `env: { AI: Cloudflare.Workers.AI() }` | None. |
| AI Gateway | `Cloudflare.AI.Gateway("Id", { cacheTtl?, collectLogs?, ... })` | `const gw = yield* Cloudflare.AI.QueryGateway(Gateway)` | `Cloudflare.AI.QueryGatewayBinding` | `Ai` via `env: { GW: Gateway }` (gateway id is *not* in env; see below) | None for Workers-AI-through-gateway. BYOK to OpenAI/Anthropic is a separate `ProviderKey` resource. |
| Cron trigger | none (attached to the Worker) | `yield* Cloudflare.Workers.cron("*/5 * * * *", (controller) => effect)` | `Cloudflare.Workers.CronEventSourceLive` | n/a; async Workers use `crons: [...]` prop + own `scheduled` export | None. slopcop already uses this. |
| D1 (already used) | `Cloudflare.D1.Database("Id", { name, migrationsDir, migrationsTable })` | `yield* Cloudflare.D1.QueryDatabase(Database)` | `Cloudflare.D1.QueryDatabaseBinding` | `D1Database` via `env: { DB }` | None. slopcop wraps it in `alchemy/SQL/D1` for an Effect `SqlClient`. |

Everything below cites either slopcop's source, the `alchemy@2.0.0-beta.67` package source (`npm pack`ed from the registry), or the official docs at alchemy.run. Where the docs describe behaviour that is **not** in beta.67, it is called out explicitly ([Doc drift](#doc-drift-alchemyrun-vs-alchemy200-beta67)).

## Version under study

- slopcop pins `alchemy: 2.0.0-beta.67` in its pnpm catalog and exempts it from `minimumReleaseAge` ([`.repos/slopcop/pnpm-workspace.yaml`](../../.repos/slopcop/pnpm-workspace.yaml), `catalog.alchemy` and `minimumReleaseAgeExclude`).
- `npm view alchemy@2.0.0-beta.67` resolves to `https://registry.npmjs.org/alchemy/-/alchemy-2.0.0-beta.67.tgz`; the package ships its TypeScript sources under `src/` (the `bun`/`worker` export conditions point at `./src/*.ts`, `import` at `./lib/*.js`) — `package.json` `exports`.
- npm dist-tags on 2026-09-08: `latest: 2.0.0-beta.76`, `next: 2.0.0-beta.72`. The alchemy.run docs track `latest`, so they are nine betas ahead of slopcop's pin; the drift that matters is listed at the end.
- slopcop's `node_modules` is not checked out in this repo's `.repos/slopcop` snapshot, so the package was inspected from the registry tarball instead.

## How slopcop declares Cloudflare resources today (the pattern to copy)

slopcop's stack is `Alchemy.Stack("SlopCop", { providers: Layer.mergeAll(Cloudflare.providers(), Command.providers()), state: Cloudflare.state() }, Effect.gen(...))` ([`alchemy.run.ts`](../../.repos/slopcop/alchemy.run.ts)). Resources are declared as module-level constants in `packages/infra/src` and `yield*`ed in the stack:

- D1: `Cloudflare.D1.Database("SlopCopDatabase", { name, migrationsTable: "slopcop_migrations", migrationsDir: "./packages/infra/src/Sql/migrations" })` ([`packages/infra/src/Sql.ts`](../../.repos/slopcop/packages/infra/src/Sql.ts)).
- Queues: `Cloudflare.Queues.Queue("GitHubEventsQueue", { name })` ([`packages/infra/src/GitHubEventQueueResources.ts`](../../.repos/slopcop/packages/infra/src/GitHubEventQueueResources.ts)).

Workers are `Cloudflare.Worker(id, props, Effect.gen(init))` with `main: import.meta.url` so the Worker file is its own entrypoint. The init phase `yield*`s bindings (`Cloudflare.D1.QueryDatabase(resource)`, `Cloudflare.Queues.WriteQueue(resource)`, `Cloudflare.RateLimit(...)`) and returns `{ fetch }`; the binding implementation layers are provided at the end with `Effect.provide([Cloudflare.D1.QueryDatabaseBinding, Cloudflare.Queues.WriteQueueBinding, ...])` ([`apps/api/src/Worker.ts`](../../.repos/slopcop/apps/api/src/Worker.ts), [`apps/webhook-ingress/src/Worker.ts`](../../.repos/slopcop/apps/webhook-ingress/src/Worker.ts)).

The mechanism behind every `*Binding` layer is the same. Taking D1 as the example: `QueryDatabaseBinding` is a `Layer.effect(QueryDatabase, ...)` that reads `WorkerEnvironment` and the host `Worker`, and returns a function which, when `!globalThis.__ALCHEMY_RUNTIME__` (deploy time), calls `host.bind\`${database}\`({ bindings: [{ type: "d1", name: database.LogicalId, databaseId }] })`, and at runtime resolves `env[database.LogicalId]` lazily (`src/Cloudflare/D1/QueryDatabaseBinding.ts`). The binding name on `env` is therefore the resource's **logical id** (`"SlopCopDatabase"`), not its physical name.

## Worker entrypoint: how `scheduled` and Workflow classes are exported

In the Effect form (`main: import.meta.url` + an `Effect.gen` implementation), Alchemy does **not** use the user's file as the runtime entry. `WorkerBundle` injects a virtual entry via a rolldown plugin (`makeEffectVirtualEntry`, `src/Cloudflare/Workers/WorkerBundle.ts`). The generated module is, verbatim in shape:

```ts
import { env, DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";
import { makeDurableObjectBridge, makeWorkerBridge, makeWorkflowBridge } from "alchemy/Cloudflare";
import entrypoint from "<your main>";
const meta = { entrypoint, stack: { name, stage } };
export default makeWorkerBridge(WorkerEntrypoint, meta);
const WorkflowBridgeFn = makeWorkflowBridge(WorkflowEntrypoint, meta);
export class MyWorkflow extends WorkflowBridgeFn("MyWorkflow") {}
```

- **`scheduled`**: `makeWorkerBridge` builds a `WorkerEntrypoint` subclass and, in its constructor, installs an instance method for every name in `ExportedHandlerMethods = ["fetch","tail","trace","tailStream","scheduled","test","email","queue"]` that runs `built.export[methodName](input, env, ctx)` inside a per-event `Scope` (`src/Cloudflare/Workers/WorkerBridge.ts`; the list is in `src/Cloudflare/Workers/Worker.ts`). So you never write `scheduled` yourself. `Cloudflare.Workers.cron` registers a listener via `RuntimeContext.listen` that filters `event.type === "scheduled"` and `controller.cron === expression` (`src/Cloudflare/Workers/CronEventSource.ts`). The returned handler object stays `{ fetch, ...rpc }`.
- **Workflow classes**: `Cloudflare.Workflow(name, impl)` calls `worker.export(name, { kind: "workflow", make })` and `worker.bind` with `{ type: "workflow", name, workflowName, className: name }` (`src/Cloudflare/Workflows/Workflow.ts`). `WorkerProps.exports` is documented as "Tracks Durable Object and Workflow exports for Effect-native Workers only. Populated automatically from bindings; do not set manually." (`src/Cloudflare/Workers/Worker.ts`). The bundle plugin then emits one `export class <name> extends WorkflowBridgeFn("<name>") {}` per workflow export. **The class name Cloudflare sees is the logical id you pass to `Cloudflare.Workflow`.**
- **Async form**: if `main` points at a plain module and no Effect implementation is given, the file is bundled as-is; you export your own `scheduled` and your own `WorkflowEntrypoint` subclasses, and declare bindings on `env` ([Workers guide, "Typed env for async Workers"](https://alchemy.run/cloudflare/compute/workers); `WorkerProps.crons` doc in `Worker.ts`).

One platform limit worth knowing: a *version* Worker (preview/canary via `version.parent`) "cannot host Durable Object or Workflow classes — their migrations would apply to the parent's script" ([Workers guide, "What a version carries"](https://alchemy.run/cloudflare/compute/workers)).

## Workflow classes and bindings

**Resource call (Effect edition).** The class form, from the `Workflow` doc comment and the guide:

```ts
// src/workflow.ts
export default class MyWorkflow extends Cloudflare.Workflow<MyWorkflow>()(
  "MyWorkflow",
  Effect.gen(function* () {
    // init phase: bind resources, e.g. const db = yield* Cloudflare.D1.QueryDatabase(Database)
    return Effect.fn(function* (input: { value: string }) {
      const r = yield* Cloudflare.Workflows.task("step", Effect.succeed(input.value), {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "1 minute",
      });
      yield* Cloudflare.Workflows.sleep("cooldown", "30 seconds");
      return { received: r };
    });
  }),
) {}
```

Sources: `src/Cloudflare/Workflows/Workflow.ts` (`@example Minimal workflow`), [Workflows guide](https://alchemy.run/cloudflare/compute/workflows). The `WorkflowClass` signature also allows the non-class form `Cloudflare.Workflow(name, impl)` returning `Effect<WorkflowHandle, never, Worker | InitReq>` (same file, `WorkflowClass` interface).

Step primitives exported from `Cloudflare.Workflows`: `task(name, effect, options?)`, `sleep(name, duration)`, `sleepUntil(name, timestamp)`, `waitForEvent<T>(name, { type, timeout? })`, plus services `WorkflowEvent` (`{ payload, timestamp, instanceId, workflowName, schedule? }`) and `WorkflowStepContext` (`{ step, attempt, config }`) (`Workflow.ts`). `task` captures the surrounding context so bindings resolved in the init phase work inside a step without extra plumbing (`task` implementation and `@example Accessing env bindings inside a task`).

**How it binds to a Worker.** The Workflow *is* a binding: `Cloudflare.Workflow(...)` requires the `Worker` service, so you `yield*` it inside the host Worker's init phase. It then (a) creates a `WorkflowResource` with `workflowName = makeWorkflowName(worker.workerName, name)` and `scriptName = worker.workerName`, (b) calls `worker.bind` with `{ type: "workflow", name, workflowName, className: name }`, (c) at runtime reads `env[name]` and wraps it in a `WorkflowHandle` with `create`, `createBatch`, `get` (`Workflow.ts`). So the env key is the workflow's logical id and the handle is typed:

```ts
export default Cloudflare.Worker("Worker", { main: import.meta.url },
  Effect.gen(function* () {
    const workflow = yield* MyWorkflow;
    return {
      fetch: Effect.gen(function* () {
        const instance = yield* workflow.create({ params: { value: "x" } });
        const status = yield* (yield* workflow.get(instance.id)).status();
        ...
      }),
    };
  }),
);
```

([Workflows guide, "Trigger from a Worker"](https://alchemy.run/cloudflare/compute/workflows).) No additional `*Binding` layer is needed for the workflow itself; bindings *used inside* the workflow body (D1, R2, AI, ...) still need their layers provided on the Workflow's init effect, exactly as on a Worker.

**Lifecycle.** `WorkflowProvider.reconcile` calls Cloudflare's `putWorkflow({ accountId, workflowName, className, scriptName })` ("a true PUT-as-upsert"); `delete` calls `deleteWorkflow`. In `alchemy dev` the resource is local-only (`workflowId: "dev:<uuid>"`) and `diff` forces an update on first real deploy (`Workflow.ts`, `WorkflowProvider`). Local dev maps `workflow` bindings to `Workflows.local({ binding, workflowName, className, scriptName })` in the local workerd (`src/Cloudflare/Workers/LocalWorkerProvider.ts`).

**Async form.** `env: { MY_WORKFLOW: Cloudflare.Workflow<{ value: string }>("MyWorkflow", { className: "MyWorkflow", scriptName?: host.workerName }) }`; `InferEnv` maps `WorkflowLike<Params>` to the native `Workflow<Params>` type (`src/Cloudflare/Workers/InferEnv.ts`). Cross-script references "are bindings only — Alchemy does not drive `putWorkflow` for the foreign class, so deploy the host first" (`Workflow.ts` doc, "Cross-Script Binding").

**Gap:** none. Cron-triggered workflows are not a separate feature — pair `Cloudflare.Workers.cron` with `workflow.create(...)` in the handler (the guide's "Cron triggers — trigger workflows on a schedule" cross-link).

## Browser Rendering binding

**No cloud resource** — Browser Rendering is account-level; the only Alchemy piece is the Worker-only binding `Cloudflare.Browser` (`src/Cloudflare/Workers/Browser.ts`: "a Worker-only binding with no backing cloud resource"). It is built with `Binding.Service({ id: "Cloudflare.Browser", defaultName: "BROWSER", toWorkerBinding: (b) => ({ type: "browser", name: b.name }) })`.

**Effect form (recommended by the source docs):**

```ts
Cloudflare.Worker("BrowserWorker", { main: import.meta.url },
  Effect.gen(function* () {
    const browser = yield* Cloudflare.Browser("BROWSER");
    return {
      fetch: Effect.gen(function* () {
        const md = yield* browser.markdown({ url: "https://example.com" });
        return yield* HttpServerResponse.json({ markdown: md.result });
      }),
    };
  }).pipe(Effect.provide(Cloudflare.Workers.BrowserBinding)),
);
```

(`Browser.ts` doc example; [Browser rendering guide](https://alchemy.run/cloudflare/compute/browser-rendering).) `BrowserBinding = makeBindingLayer(Browser, ...)` — `makeBindingLayer` registers `binding.toWorkerBinding()` on the host Worker at deploy time and builds the client from a lazy `env[binding.name]` accessor (`src/Cloudflare/Workers/BindingLayer.ts`, `BrowserBinding.ts`).

**Client surface** (`BrowserClient`, `Browser.ts`): `raw` (the native `cf.BrowserRun`), `fetch(...)`, `quickAction(action, options)`, and typed shortcuts `screenshot`/`pdf` (return `Stream<Uint8Array, BrowserError>`), `content`/`scrape`/`links`/`snapshot`/`json`/`markdown` (return parsed success payloads). Non-2xx responses fail with `BrowserError` carrying the parsed `errors[0].message` (`BrowserBinding.ts`, `failResponse`). For puppeteer, `yield* browser.raw` hands the native binding to `@cloudflare/puppeteer`; `nodejs_compat` is required for that library (guide, "Drive it with puppeteer") — slopcop already sets `compatibility: { flags: ["nodejs_compat"] }` on every Worker.

**Async form:** `env: { BROWSER: Cloudflare.Browser("BROWSER") }`; `InferEnv` yields `BrowserRun` (`InferEnv.ts`).

**Local dev:** the local provider maps `browser` bindings to `Browser.remote(b.name)` — i.e. `alchemy dev` proxies to the real Cloudflare service with your credentials, it does not emulate a browser (`LocalWorkerProvider.ts`, `toRuntimeBinding` switch). There is also `Cloudflare.Workers.BrowserLocal`, a layer that drives the REST data plane from stack-eval code (e.g. an `Alchemy.Action`) for the JSON quick actions only; `raw`, `fetch`, `screenshot` and `pdf` "have no Cloudflare REST equivalent and die" there (`src/Cloudflare/Workers/BrowserLocal.ts`).

**Gap:** none for the binding. Unverified: whether Browser Rendering can be used from inside a **Workflow** step — the source says `task` threads `WorkerEnvironment` through, and `BrowserBinding` only needs `WorkerEnvironment`, so it should work, but I found no example or test in the package for that combination.

## R2 buckets

**Resource call:** `Cloudflare.R2.Bucket("Id", props?)` with `BucketProps = { name?, storageClass?, jurisdiction?, locationHint?, domains?, lifecycleRules?, cors? }`; the physical `name` defaults to `${app}-${stage}-${id}` (`src/Cloudflare/R2/Bucket.ts`). Attributes include `bucketName`, `jurisdiction`, `domains`, `lifecycleRules`, `cors`. Follow slopcop's naming convention by passing `name: resourceNames.name("…")`.

**Worker binding:** three access-scoped services, each `Binding.Service<(bucket: Bucket) => Effect<Client>>`:
- `Cloudflare.R2.ReadBucket` → `{ raw, head, get, list }` (`R2/ReadBucket.ts`)
- `Cloudflare.R2.WriteBucket` → `{ put, delete, createMultipartUpload, resumeMultipartUpload }` (`R2/WriteBucket.ts`); `put` accepts `ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob | Stream<Uint8Array>` and needs `contentLength` for Effect `Stream` inputs.
- `Cloudflare.R2.ReadWriteBucket` → both (`R2/ReadWriteBucket.ts`).

Provide `Cloudflare.R2.ReadWriteBucketBinding` (or `ReadBucketBinding` / `WriteBucketBinding`). `makeBucketBinding` registers `{ type: "r2_bucket", name: bucket.LogicalId, bucketName, jurisdiction }` on the host Worker at deploy time and reads `env[bucket.LogicalId]` at runtime (`R2/BucketBinding.ts`). `get` returns an `ObjectBody` whose `body` is an Effect `Stream<Uint8Array, R2Error>` and whose `text()/json()/arrayBuffer()/bytes()/blob()` are Effects (`BucketBinding.ts`, `makeR2ObjectWrappers`). Errors are typed `R2Error` ([R2 guide](https://alchemy.run/cloudflare/data/r2)).

```ts
const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
yield* bucket.put(key, request.stream, { contentLength: Number(request.headers["content-length"] ?? 0) });
const object = yield* bucket.get(key);   // ObjectBody | null
```

**Outside a Worker:** `ReadBucketHttp` / `WriteBucketHttp` / `ReadWriteBucketHttp` implement the same client over Cloudflare's HTTP API with a scoped API token "for when a native binding isn't available" (R2 guide; files `R2/*BucketHttp.ts`), and `*BucketLocal` variants exist for `alchemy dev` (`R2/*BucketLocal.ts`). Local dev emulates buckets whose name is `dev:`-prefixed and proxies otherwise (`LocalWorkerProvider.ts`, `r2_bucket` case).

**Async form:** `env: { Bucket }` → `R2Bucket` (`InferEnv.ts`).

**Gap:** none. See doc drift for `publicAccess` / `forceDestroy`, which are documented but absent from beta.67.

## AI binding and AI Gateway

There are two distinct things in Alchemy, and the docs are explicit about when to use which ([Workers AI guide](https://alchemy.run/cloudflare/ai/workers-ai), "When to add an AI Gateway").

### Plain Workers AI binding — `Cloudflare.Workers.AI`

Worker-only binding, `{ type: "ai", name }`, default name `"AI"` (`src/Cloudflare/Workers/AI.ts`: "the plain `{ type: "ai" }` Worker binding: the runtime value is the same `env.AI` handle you would declare in `wrangler.json`"). Provide `Cloudflare.Workers.AIBinding` (`Workers/AIBinding.ts`).

```ts
const ai = yield* Cloudflare.Workers.AI();
const languageModel = ai.model({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", parameters: { temperature: 0.7, maxTokens: 1024 } });
// runtime: yield* LanguageModel.generateText({ prompt }).pipe(Effect.provide(languageModel))
```

`AIClient = { raw, run(model, inputs, options?), models(params?), model(options) }` where `run` is typed by the `AiModels` catalog from `@cloudflare/workers-types` and fails with `WorkersAIError`; `model(...)` returns a `Layer<LanguageModel, never, RuntimeContext>` for `effect/unstable/ai` (`AI.ts`, `AI/LanguageModel.ts`). `ai.run(model, inputs, { gateway: { id } })` can also route a plain binding through a gateway per call (`AIClient.run` doc: "pass `options` (e.g. `returnRawResponse`, `gateway`) through").

Async form: `env: { AI: Cloudflare.Workers.AI() }` → `Ai`. Local dev: `Ai.remote(b.name)` (proxied, not emulated) (`LocalWorkerProvider.ts`).

### AI Gateway resource + `QueryGateway` binding

**Resource call:** `Cloudflare.AI.Gateway("Id", props?)`, type id `"Cloudflare.AI.Gateway"` (alias `"Cloudflare.AiGateway"`). Props: `id?` (defaults to `${app}-${stage}-${id}`), `cacheTtl`, `cacheInvalidateOnUpdate`, `collectLogs`, `rateLimitingInterval/Limit/Technique`, `authentication`, `dlp`, `isDefault`, `logManagement(+Strategy)`, `logpush(+PublicKey)`, `otel`, `storeId`, `stripe`, `spendLimits`, `zdr` (`src/Cloudflare/AI/Gateway.ts`). Attributes include `gatewayId` and `accountId`. Reconcile is observe-then-upsert against `@distilled.cloud/cloudflare/ai-gateway` (`GatewayResourceProvider`).

**Worker binding:** `yield* Cloudflare.AI.QueryGateway(Gateway)` with `Cloudflare.AI.QueryGatewayBinding` provided. Important detail on how it reaches `env`: `QueryGatewayBinding` registers a binding of **`type: "ai"`** named after the gateway's logical id, then at runtime does `env[gateway.LogicalId].gateway(gatewayId)` where `gatewayId` comes from the resource attribute captured at bind time (`src/Cloudflare/AI/QueryGatewayBinding.ts`). In other words the Worker gets an ordinary Workers AI handle on `env`, and Alchemy supplies the gateway id from stack state — there is no gateway id in `env` and nothing to configure in wrangler.

`QueryGatewayClient = { raw: Ai, gateway: AiGateway, id, patchLog, getLog, getUrl(provider?), run(data, options?), model(options) }`; errors are `AiGatewayError` (tag) (`AI/QueryGateway.ts`). `model(...)` is the same `makeLanguageModelLayer` adapter as the plain binding but with `gateway: { id }` injected into every `ai.run` (`AI/LanguageModel.ts`, `callRaw`).

```ts
export const Gateway = Cloudflare.AI.Gateway("Gateway", { cacheTtl: 60, collectLogs: true });
// in the Worker init phase
const aiGateway = yield* Cloudflare.AI.QueryGateway(Gateway);
const languageModel = aiGateway.model({ model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
// ...
}).pipe(Effect.provide(Cloudflare.AI.QueryGatewayBinding))
```

([AI Gateway guide](https://alchemy.run/cloudflare/ai/ai-gateway); `Gateway.ts` doc examples.)

**External providers through the gateway (OpenAI, Anthropic, …).** The `LanguageModel` adapter only targets **Workers AI models** (`ai.run(model, ...)`), so `aiGateway.model({...})` cannot address OpenAI/Anthropic. For those, the source gives two paths:
1. `aiGateway.getUrl(provider)` / `aiGateway.run({ provider, endpoint, headers, query })` — the native `AiGateway` binding's universal endpoint (`QueryGateway.ts` example uses `provider: "workers-ai"`). Pair `getUrl("openai")` with `@effect/ai-openai` (slopcop already depends on `@effect/ai-openai` in its catalog) by pointing that client's base URL at the gateway URL. **Unverified**: I did not find an end-to-end example in beta.67 of `@effect/ai-openai` + `getUrl`; it should work because the gateway URL is a plain OpenAI-compatible base URL, but confirm in a spike.
2. BYOK: `Cloudflare.AI.ProviderKey({ gatewayId, providerSlug: "openai" | "anthropic" | ..., store: { storeId, accountId }, value: Redacted, alias?, defaultConfig?, rateLimit? })` creates a Secrets Store `Secret` named `{gatewayId}_{providerSlug}_{alias}` plus a `GatewayProvider` config; the gateway must have `storeId` set (`AI/ProviderKey.ts`, `AI/GatewayProvider.ts`). The key is "never bound into the Worker runtime".

**Async form:** `env: { GW: Gateway }` → `Ai` (`InferEnv.ts` maps `AI.Gateway` to `Ai`). Note this only gives the async handler the AI binding; it must know the gateway id itself.

**Gap:** none for the resource or the binding. AI Gateway has no local emulation in beta.67 — the underlying `ai` binding is `Ai.remote` in dev, so calls in `alchemy dev` hit the real gateway.

## Cron triggers on a Worker

**Effect form (what slopcop already does):** in `apps/github-data-sync/src/Worker.ts`, slopcop calls

```ts
yield* Cloudflare.Workers.cron("*/5 * * * *", () => encode(job).pipe(Effect.flatMap((body) => queue.send(body, { contentType: "json" })), Effect.retry({ times: 2 }), Effect.tapError(...)))
```

and provides `Cloudflare.Workers.CronEventSourceLive` alongside the D1/Queue layers ([`apps/github-data-sync/src/Worker.ts`](../../.repos/slopcop/apps/github-data-sync/src/Worker.ts)). This is exactly the documented pattern ([Cron guide](https://alchemy.run/cloudflare/messaging/cron)).

**Mechanism** (`src/Cloudflare/Workers/CronEventSource.ts`): `cron(expression, process)` uses the `CronEventSource` service; `CronEventSourceLive` (a) at deploy time calls `host.bind("Cron(<expr>)", { crons: [expression] })` under the host's namespace, and (b) at runtime registers `ctx.listen` for events with `type === "scheduled"` whose `controller.cron === expression`. The handler receives Cloudflare's `ScheduledController` (`scheduledTime`, `cron`, `noRetry()`). Multiple `cron` calls register independent handlers; each only fires for its own expression.

**Failure semantics:** the listener wraps the handler in `Effect.catchCause(() => Effect.void)`, so "a failing handler won't crash the Worker ... Cloudflare never observes a failed invocation, so its platform-level retry (and `controller.noRetry()`) never comes into play here. Express retry declaratively with `Effect.retry`" (`CronEventSource.ts` doc). slopcop's `Effect.retry({ times: 2 })` + `Effect.tapError(logError)` is the recommended shape.

**Deploy side:** the Worker provider merges `getCronBindings(bindings)` with `props.crons` into the script's Cron Triggers; `worker.crons` is an output attribute (`LocalWorkerProvider.ts` lines ~460 and ~908; `WorkerProps.crons` doc; Cron guide "Deploy it"). Cron triggers are script-level settings that a version Worker cannot carry and that dispatch-namespace Workers ignore (`WorkerProps.namespace` doc).

**Async form:** `crons: ["0 12 * * *"]` on the Worker props plus your own `export default { async scheduled(controller, env) {...} }`; `crons: []` removes all triggers (`WorkerProps.crons`).

**Gap:** none. **Unverified:** whether `alchemy dev` can fire a cron locally (e.g. a `__scheduled` test endpoint). The local provider passes `crons` into the local workerd config, but I found no local trigger mechanism in the beta.67 source; the official test strategy is to deploy and poll (Cron guide, "Poll until it fires").

## D1 (already used)

For completeness, since the ticket lists it: `Cloudflare.D1.Database("Id", { name?, primaryLocationHint?, readReplication?, jurisdiction?, migrationsDir?, migrationsTable?, importFiles?, clone? })` (`src/Cloudflare/D1/Database.ts`). Migrations in `migrationsDir` are applied on every deploy; `migrationsTable` defaults to `"d1_migrations"` with the wrangler-compatible `(id, name, applied_at)` schema. slopcop uses `migrationsDir` + `migrationsTable: "slopcop_migrations"` and wraps the binding with `D1(d1, { transformQueryNames, transformResultNames })` from `alchemy/SQL/D1` to expose an Effect `SqlClient` (`packages/infra/src/Sql.ts`). Binding: `Cloudflare.D1.QueryDatabase(resource)` + `Cloudflare.D1.QueryDatabaseBinding` (`D1/QueryDatabaseBinding.ts`), env type `D1Database`. Local dev emulates `dev:`-id databases and proxies real ones (`LocalWorkerProvider.ts`).

## Doc drift: alchemy.run vs `alchemy@2.0.0-beta.67`

The website documents `latest` (`2.0.0-beta.76`). Differences that would bite if copied verbatim into a beta.67 project:

| Documented on alchemy.run | In beta.67 source | Action |
| --- | --- | --- |
| `Cloudflare.D1.Database("my-db", { migrations: "./migrations" })`, bookkeeping in `__alchemy_migrations` ([D1 guide](https://alchemy.run/cloudflare/data/d1)) | Prop is `migrationsDir`; table is `migrationsTable` (default `d1_migrations`) (`D1/Database.ts`) | Use `migrationsDir` as slopcop does. |
| `Cloudflare.R2.Bucket("Assets", { publicAccess: true })` → `publicDomain`; `forceDestroy: true` ([R2 guide](https://alchemy.run/cloudflare/data/r2)) | Neither `publicAccess`, `publicDomain` nor `forceDestroy` appears in `R2/Bucket.ts` (grep count 0) | Public access needs `domains` (custom domain) or a newer alchemy; empty buckets manually before destroy. |

Everything else quoted above (Workflow class form and step API, `Cloudflare.Browser` + `BrowserBinding`, `ReadWriteBucket` + `ReadWriteBucketBinding`, `Workers.AI` + `AIBinding`, `AI.Gateway` + `QueryGateway` + `QueryGatewayBinding`, `Workers.cron` + `CronEventSourceLive`) was verified to exist with the same names and shapes in the beta.67 tarball.

## Recommendation for this project

Copy slopcop's layout: resources as module constants in an `infra` package, Workers with `main: import.meta.url`, bindings `yield*`ed in the init phase, and one `Effect.provide([...Binding layers])` at the end of the init effect. For the new pieces:

- Put the scrape/analysis pipeline in a `Cloudflare.Workflow` class hosted by the Worker that also owns the cron; the cron handler calls `workflow.create(...)`.
- Inside workflow steps, use `Cloudflare.Browser("BROWSER")` (provide `Workers.BrowserBinding` on the workflow's init effect) and `Cloudflare.R2.ReadWriteBucket(Bucket)` (provide `R2.ReadWriteBucketBinding`); wrap each external call in `Cloudflare.Workflows.task` so it runs exactly once per replay.
- Use `Cloudflare.AI.Gateway` + `QueryGateway` for Workers AI models; if the LLM must be OpenAI/Anthropic, route `@effect/ai-openai` through `aiGateway.getUrl("openai")` (spike this first — see unverified items).

## Unverified

1. Browser Rendering from inside a Workflow `task` — should work by construction (`task` threads `WorkerEnvironment`), no example found in beta.67.
2. Driving an OpenAI-compatible Effect AI client (`@effect/ai-openai`) through `aiGateway.getUrl(...)` — no example in beta.67; the `LanguageModel` adapter shipped in the package only speaks Workers AI.
3. Firing cron triggers in `alchemy dev` — no local trigger mechanism found in the beta.67 source.
4. The exact `WorkflowHandle` typing in the class form (`Cloudflare.Workflow<Self>()`) was read from the `WorkflowClass` interface, not compiled; a `tsc` check in a spike is cheap insurance.

## Sources

Local (slopcop snapshot, pinned `alchemy@2.0.0-beta.67`):
- `.repos/slopcop/pnpm-workspace.yaml` (catalog)
- `.repos/slopcop/alchemy.run.ts`
- `.repos/slopcop/packages/infra/src/{Sql,GitHubEventQueueResources,GitHubDataSyncQueueResources,CloudflareResourceNames}.ts`
- `.repos/slopcop/apps/{api,github-events,github-data-sync,webhook-ingress}/src/Worker.ts`

Package (`npm pack alchemy@2.0.0-beta.67`, `package/src/Cloudflare/...`):
- `Workers/Worker.ts` (`WorkerProps`, `ExportedHandlerMethods`, two-phase doc), `Workers/WorkerBundle.ts` (`makeEffectVirtualEntry`), `Workers/WorkerBridge.ts`, `Workers/Binding.ts`, `Workers/BindingLayer.ts`, `Workers/InferEnv.ts`, `Workers/LocalWorkerProvider.ts`
- `Workflows/Workflow.ts`, `Workflows/WorkflowBridge.ts`
- `Workers/Browser.ts`, `Workers/BrowserBinding.ts`, `Workers/BrowserLocal.ts`
- `R2/Bucket.ts`, `R2/BucketBinding.ts`, `R2/ReadBucket.ts`, `R2/WriteBucket.ts`, `R2/ReadWriteBucket.ts`, `R2/ReadWriteBucketBinding.ts`
- `Workers/AI.ts`, `Workers/AIBinding.ts`, `AI/Gateway.ts`, `AI/QueryGateway.ts`, `AI/QueryGatewayBinding.ts`, `AI/LanguageModel.ts`, `AI/ProviderKey.ts`, `AI/GatewayProvider.ts`
- `Workers/CronEventSource.ts`
- `D1/Database.ts`, `D1/QueryDatabaseBinding.ts`

Official docs (alchemy.run, fetched 2026-09-08, describing `latest` = beta.76):
- https://alchemy.run/llms.txt (index)
- https://alchemy.run/cloudflare/compute/workers
- https://alchemy.run/cloudflare/compute/workflows
- https://alchemy.run/cloudflare/compute/browser-rendering
- https://alchemy.run/cloudflare/data/r2
- https://alchemy.run/cloudflare/data/d1
- https://alchemy.run/cloudflare/ai/workers-ai
- https://alchemy.run/cloudflare/ai/ai-gateway
- https://alchemy.run/cloudflare/messaging/cron
