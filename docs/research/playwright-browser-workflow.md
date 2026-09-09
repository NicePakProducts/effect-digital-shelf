# Playwright over Browser Rendering inside a Cloudflare Workflow step (#18)

Task ticket **Smoke Playwright over the Browser Rendering binding inside a
Workflow step** (#18), spawned by **Scrape providers as Effect services** (#13).
Also closes the "Browser Rendering from inside a Workflow task" item the
Alchemy research (#4) left unverified.

## TL;DR

- **Yes.** `@cloudflare/playwright` 1.3.6 driven from Alchemy's
  `Cloudflare.Browser("BROWSER")` `raw` binding works inside a
  `Cloudflare.Workflow` step (`Cloudflare.Workflows.task`) on a deployed
  Worker with `nodejs_compat`. The binding is resolved in the Workflow's init
  phase and `browser.raw` is read inside the step; `task` threads the runtime
  context through with no extra plumbing, exactly as the Alchemy source
  promised.
- One navigation yields everything the Scrape envelope needs: final URL,
  status code, response headers, cookies from the browser context, `innerText`,
  user agent, rendered HTML, plus the browser session id and the request
  headers Chrome actually sent. Only `ipInfo` is out of reach (Scrappey-only,
  already `Option` per #13).
- **No fallback to `@cloudflare/puppeteer` is needed.**
- Five deployed runs: `example.com`, a 302 that sets a cookie, a JS-rendered
  SPA, a real retailer homepage (1.9 MB of HTML, status 200, cookies present)
  and a navigation failure. All behaved; results below.
- Three gotchas the provider module must carry, all found the hard way:
  1. `@cloudflare/playwright` must be **dynamically imported** inside the step
     (or the fetch handler). A static import breaks `alchemy deploy` in Node
     with `Received protocol 'cloudflare:'`.
  2. Alchemy's bundler **defines `navigator.userAgent` as
     `"Cloudflare-Workers"` at build time** (and `process.env.NODE_ENV`), so a
     function-form `page.evaluate(() => navigator.userAgent)` is rewritten
     before Playwright serialises it and returns the Worker's string. Use a
     string expression, or read the UA off the request headers.
  3. Alchemy types the binding as workers-types' `BrowserRun`; Playwright's
     `launch` wants `BrowserWorker` (`{ fetch: typeof fetch }` over lib.dom).
     Same object, incompatible `fetch` signatures: one cast at the boundary.
- Smallest working slice: one Worker, one Workflow, one step, in
  [`docs/research/playwright-browser-workflow/`](./playwright-browser-workflow/).
  Deployed and destroyed on 2026-09-09; nothing is left in the account.

## Working versions

| Package | Version | Note |
|---|---|---|
| alchemy | 2.0.0-beta.76 | the `Cloudflare.Browser` / `Cloudflare.Workflow` Effect forms; bundles with rolldown 1.2.7 via `@alchemy.run/cloudflare-runtime` |
| @cloudflare/playwright | 1.3.6 | upstream Playwright 1.58.2; talks CDP to Browser Rendering since 1.3.0 |
| effect | 4.0.0-rc.112 | plus `@effect/platform-node` rc.112 for the Alchemy CLI |
| Worker compatibility | date `2026-09-01`, flags `["nodejs_compat"]` | as in the Hyperdrive smoke (#25) |
| Node / pnpm | 26.8.1 / 11.17.0 | |

Account `NP Brands` (`3056ba6cc5916b47fece5b044c6a8434`), Worker
`digital-shelf-playwright-workflow-smoke` on `workers.dev`, Workflow class
`SmokeWorkflow`. Deployed 2026-09-09 ~16:50 AEST, destroyed the same session
(`alchemy destroy`, then verified with the Workers and Workflows list APIs).

## What was deployed

```
alchemy.run.ts       Alchemy.Stack with Cloudflare.providers() and Alchemy.localState()
src/Worker.ts        Effect-form Worker: /run?url=  /status?id=  /direct?url=
src/Workflow.ts      class SmokeWorkflow: one task "fetch" (timeout 2 min, retries 0)
src/Fetch.ts         fetchEnvelope(binding, url): launch → goto → collect → close
```

The Workflow binds the browser in its init phase and reads `raw` inside the
step:

```ts
export default class SmokeWorkflow extends Cloudflare.Workflow<SmokeWorkflow>()(
  "SmokeWorkflow",
  Effect.gen(function* () {
    const browser = yield* Cloudflare.Browser("BROWSER")
    return Effect.fn(function* (input: { readonly url: string }) {
      const envelope = yield* Cloudflare.Workflows.task(
        "fetch",
        Effect.gen(function* () {
          const raw = yield* browser.raw
          return yield* fetchEnvelope(raw, input.url)
        }).pipe(Effect.orDie),
        { timeout: "2 minutes", retries: { limit: 0, delay: "1 second" } },
      )
      return { input, envelope, ranInWorkflow: true }
    })
  }).pipe(Effect.provide(Cloudflare.Workers.BrowserBinding)),
) {}
```

`/direct` runs the same `fetchEnvelope` in the Worker's `fetch` handler as a
control, so a Workflow-only failure would have stood out.

## Driving Alchemy without a browser login

Alchemy does not read wrangler's OAuth file and had no profile on this
machine. `alchemy login` is interactive. What worked non-interactively:

```sh
CI=true \
CLOUDFLARE_ACCOUNT_ID=3056ba6cc5916b47fece5b044c6a8434 \
CLOUDFLARE_API_TOKEN="$(grep '^oauth_token' ~/.wrangler/config/default.toml | sed -E 's/.*"(.+)"/\1/')" \
pnpm exec alchemy deploy --yes
```

- `CI=true` makes the Cloudflare auth provider pick the `env` method without
  prompting (`src/Cloudflare/Auth/AuthProvider.ts`, `configureCredentials`).
- wrangler's OAuth access token is accepted as a Bearer token by the Workers,
  Workflows and Browser Rendering APIs (verified with `curl` before deploying;
  `wrangler whoami` refreshes it, and it expires after about an hour).
- `Alchemy.localState()` keeps state under `.alchemy/state/`; the
  `Cloudflare.state()` remote store slopcop uses would have deployed a state
  Worker into the account for a throwaway smoke. Which one infra adopts is
  #22's call.
- `alchemy deploy` evaluates `alchemy.run.ts` and the Worker module **in
  Node** (plan and init phases), which is where gotcha 1 bites.

## Results

All runs through the Workflow unless marked. `launch` is
`launch(binding, { keep_alive: 30_000 })`, `navigate` is
`page.goto(url, { waitUntil: "load", timeout: 30_000 })`, `extract` is
headers, cookies, innerText, two UA probes, request headers and `content()`.

| Case | URL | Status | Final URL | Cookies | innerText | HTML | launch / navigate / extract (ms) | Step (ms) | Instance |
|---|---|---|---|---|---|---|---|---|---|
| control (`/direct`, no Workflow) | `https://example.com/` | 200 | same | 0 | 129 chars | 559 B | 2462 / 274 / 95 | n/a | 200 in 3.2 s |
| plain | `https://example.com/` | 200 | same | 0 | 129 | 559 B | 2875 / 479 / 563 | 4208 | `complete` |
| redirect + cookie | `https://httpbingo.org/cookies/set?smoke=1` | 200 | `https://httpbingo.org/cookies` | 1 (`smoke=1`, httpOnly, secure, Lax) | 40 | 203 B | 2399 / 1285 / 646 | 4807 | `complete` |
| JS-rendered SPA | `https://demo.playwright.dev/todomvc` | 200 | `…/todomvc/#/` | 0 | 148 (rendered app text) | 978 B | 2451 / 1037 / 95 | 3890 | `complete` |
| retailer | `https://www.chemistwarehouse.com.au/` | 200 (`server: cloudflare`) | same | 2 | 7719 | **1,948,562 B** | 2007 / 4052 / 4252 | 10826 | `complete` |
| failure | `https://nonexistent.invalid/` | – | – | – | – | – | – | ~6 s | `errored` |

The failure instance's status:

```json
{"status":"errored","output":null,
 "error":{"name":"Error",
          "message":"FetchFailure: page.goto: net::ERR_CONNECTION_RESET at https://nonexistent.invalid/\nCall log:\n  - navigating to \"https://nonexistent.invalid/\", waiting until \"load\"\n"},
 "rollback":null}
```

User agent, from the redirect run (the same on every run):

| Probe | Value |
|---|---|
| `page.evaluate("navigator.userAgent")` | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36` |
| `response.request().allHeaders()["user-agent"]` | same string; `sec-ch-ua` says `"Chromium";v="128"` |
| `page.evaluate(() => navigator.userAgent)` | `Cloudflare-Workers` (see gotcha 2) |

Timings are wall-clock inside the step; the Workflow adds well under a
second around it. A fresh browser session costs 2–3 s per Scrape, which fits
inside the 30 s per-Fetch-attempt deadline and the 180 s Scrape deadline
decided in #13 with room to spare.

## Envelope coverage against #13

| Envelope field (#13) | Source in one navigation | Verified |
|---|---|---|
| `finalUrl` | `page.url()` after `goto` (follows redirects, keeps the SPA hash) | yes |
| `statusCode` | `response.status()` of the main document | yes |
| `responseHeaders` | `response.allHeaders()` | yes (`cf-ray`, `content-type`, `cf-cache-status`, …) |
| `cookies` | `context.cookies()` | yes (name, value, domain, path, expires, httpOnly, secure, sameSite) |
| `innerText` | `page.innerText("body")` | yes, rendered text on the SPA |
| `userAgent` | `page.evaluate("navigator.userAgent")` or the request's `user-agent` header | yes |
| `ipInfo` | not observable from Playwright | no; `Option.none` in browser mode as #13 decided |
| `session` | `browser.sessionId()` | yes (a uuid per launch) |
| `type` | provider constant | n/a |
| `raw` | Playwright has no vendor response body; keep the request/response header pair | n/a |
| HTML (beside the envelope) | `page.content()` | yes, 1.9 MB on the retailer |

## Gaps and gotchas

1. **Static import of `@cloudflare/playwright` breaks the deploy.** The
   package imports `cloudflare:workers` at module top level. Alchemy's
   Effect-form Worker and Workflow modules are evaluated in Node during
   `alchemy deploy` (the init phase runs there), so the CLI died with
   `Only URLs with a scheme in: file, data, and node are supported by the
   default ESM loader. Received protocol 'cloudflare:'`. Alchemy handles its
   own `cloudflare:workers` import the same way we must: a dynamic
   `import("@cloudflare/playwright")` inside the code that only runs on
   workerd (`lib/Cloudflare/Workers/cloudflare_workers.js` does
   `import("cloudflare:workers").catch(...)`). The type import stays static.
   Rolldown bundled the dynamic import into the Worker fine (2.98 MB upload).
   The same rule applies to any module reachable from the Worker's or
   Workflow's init graph, so core's `Providers/Playwright.ts` must defer the
   import, not just the caller.
2. **Build-time `define` rewrites `page.evaluate` function bodies.**
   `@alchemy.run/cloudflare-runtime/src/rolldown/plugins/options.ts`
   (`getDefine`) sets `transform.define` to `navigator.userAgent →
   "Cloudflare-Workers"` for any compatibility date ≥ 2022-03-21, plus
   `process.env.NODE_ENV` and, without `nodejs_compat`, `process.env → {}`.
   This mirrors wrangler. The minified bundle literally contains
   `n.evaluate(()=>\`Cloudflare-Workers\`)`. Rule for the provider: in-page
   code that reads those globals goes in as a **string expression**, or the
   fact is taken from the request headers; everything else in a function is
   fine. `WorkerProps.build` merges over Alchemy's rolldown options
   (`Sources/Rolldown.ts`) and could in principle override the define, but a
   string expression is simpler and bundler-proof.
3. **`BrowserRun` versus `BrowserWorker`.** Alchemy's `browser.raw` is
   workers-types' `BrowserRun` (`fetch(input: RequestInfo<unknown,
   CfProperties>, …)`); Playwright's `launch` wants `BrowserWorker`
   (`{ fetch: typeof fetch }` from lib.dom). Neither assigns to the other
   (`Request.fetcher`, `HeadersIterator`). The smoke types its parameter
   structurally as `{ fetch: (input: never, init?: never) => Promise<unknown> }`
   and casts once inside. Core's own `BrowserRendering` tag (#13) should be
   typed the same structural way so infra can hand Alchemy's binding over
   without a cast at the call site.
4. **Step output cap.** The retailer page is 1.9 MB of HTML, above the 1 MiB
   Workflow step-output limit. The smoke returned length plus a 200-char head
   and passed; the real fetch step must put HTML and inner text to R2
   **inside** the step and return keys, which ADR 0004 already specifies.
   `innerText` on that page was 7.7 KB, comfortably under the 256 KB cap.
5. **How errors surface.** With `retries.limit: 0`, a failing `task` errored
   the instance in one attempt. The instance status carries
   `error.name: "Error"` and the tagged error's name only as a prefix in
   `message`. Classification into the scrape error codes therefore has to
   happen inside the step and be written to the row by the runner's finish
   transition; the status endpoint is for reconcile (running / terminal),
   never for the error code. A DNS failure surfaced as
   `net::ERR_CONNECTION_RESET`, which maps to `navigation_failed`.
6. **Session lifetime.** `launch` per Scrape costs 2–3 s (a fresh session
   each time; `keep_alive` only matters if the session is left open). Reuse
   via `connect(binding, sessionId)` is a later optimisation; `browser.close()`
   in a `finally` released every session (the account's active-session list
   was empty afterwards).
7. **`waitUntil: "load"` was enough** for the TodoMVC SPA and the retailer;
   whether some retailers need `networkidle` or a selector wait is the
   provider ticket's business, configurable per Retailer if it comes to that.
8. **Alchemy dev.** In beta.76 the Browser binding under `alchemy dev` drives
   a local headless Chrome over CDP by default; `Alchemy.remote()` opts the
   binding into the real Browser Rendering service (doc comment in
   `src/Cloudflare/Workers/Browser.ts`). Worth knowing for #22.
9. **`retries`** on `Cloudflare.Workflows.task` requires `delay` alongside
   `limit` (`WorkflowStepConfig`); `{ limit: 0 }` alone does not type-check.

## Re-running the smoke

```sh
cd docs/research/playwright-browser-workflow
pnpm install
pnpm exec tsc --noEmit -p .
CI=true CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> pnpm exec alchemy deploy --yes
curl "$URL/direct?url=https://example.com/"
curl "$URL/run?url=https://example.com/"      # → {"id": "..."}
curl "$URL/status?id=<id>"                    # poll until complete / errored
CI=true CLOUDFLARE_ACCOUNT_ID=<id> CLOUDFLARE_API_TOKEN=<token> pnpm exec alchemy destroy --yes
```

The directory is a standalone pnpm project (its own `pnpm-workspace.yaml`
carries the `allowBuilds` for `workerd`), not a workspace package, because
`packages/infra` does not carry Alchemy yet (#22). Once infra has its
`alchemy.run.ts`, this smoke belongs beside it as an on-demand script,
outside `vp test`.

## Implications

- **Providers (#13) stand.** Playwright over `browser.raw` with `nodejs_compat`
  is confirmed; the Puppeteer fallback is not needed.
- **Core's `Providers/Playwright.ts`** must: dynamic-import the library, use
  string expressions for in-page reads of `navigator.*` / `process.env`, type
  the `BrowserRendering` tag structurally, classify inside the step, and put
  HTML to R2 inside the step.
- **Infra (#22)** gets three facts: `alchemy` must be `2.0.0-beta.76` (this
  smoke ran on it; beta.67 predates the drizzle rc5 peer pin), the CI env
  method plus `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` is enough for
  non-interactive deploys, and the Browser binding needs `Alchemy.remote()`
  under `alchemy dev` if a real render is wanted locally.
- **Alchemy research (#4)** unverified item closed: Browser Rendering works
  from inside a Workflow task.

## Sources

- `alchemy@2.0.0-beta.76` tarball: `src/Cloudflare/Workflows/Workflow.ts`
  (`task`, `WorkflowServices`, `Workflow` runtime bridge lines 810–935),
  `src/Cloudflare/Workers/Browser.ts` and `BrowserBinding.ts` (`raw`,
  `makeBindingLayer`), `src/Cloudflare/Workers/Sources/Rolldown.ts` (input
  and output options, `minify: true`, `build` merge),
  `src/Cloudflare/Auth/AuthProvider.ts` (`configureCredentials`,
  `resolveCredentials` for the `env` method), `src/State/LocalState.ts`,
  `lib/Cloudflare/Workers/cloudflare_workers.js` (the dynamic-import pattern).
- `@alchemy.run/cloudflare-runtime@2.0.0-beta.76`:
  `src/rolldown/plugins/options.ts` `getDefine` (lines 343–360).
- `@cloudflare/playwright@1.3.6`: `README.md` (CDP since 1.3.0,
  `nodejs_compat`), `index.d.ts` (`launch`, `connect`, `sessions`,
  `WorkersLaunchOptions`, `BrowserWorker`).
- Deployed bundle `.alchemy/bundles/PlaywrightWorkflowSmoke/Worker.js`
  (the folded `evaluate`).
- Cloudflare API: `GET /accounts/{id}/workers/scripts`, `GET
  /accounts/{id}/workflows` with the wrangler OAuth token (before and after).
