# Better Auth on Workers with Drizzle-D1 and its MCP OAuth support

Research for [#5](https://github.com/NicePakProducts/effect-digital-shelf/issues/5) (part of map #1). Researched 2026-09-08 against primary sources only: Better Auth docs source at the `v1.7.3` tag, Better Auth source at the same tag, the Better Auth issue tracker, npm registry metadata, the MCP specification, the MCP TypeScript SDK docs, Cloudflare docs, Claude's published client-metadata document, and the local `browser-worker` and `slopcop` code named in the ticket. Every claim carries its source; anything I could not verify is in the last section.

## Short answer

1. **Yes, Better Auth 1.7.3 runs in a Worker with `@better-auth/drizzle-adapter` on D1** (`provider: "sqlite"`, `nodejs_compat` flag). Three caveats matter: date columns must be `integer(..., { mode: "timestamp_ms" })` (the CLI's default), not `text` (open bug #10816); the adapter's transaction wrapping must stay off (its default); and a Worker-specific init hang (#10315) is open.
2. **`@better-auth/mcp` 1.7.3 covers OAuth 2.1 + PKCE, RFC 8414, RFC 9728, RFC 8707 audience binding and RFC 7591 DCR** (DCR is opt-in). It binds `aud` to the full resource URL (`https://host/mcp`), which is exactly what the old hand-rolled server was written to do after bypassing `@cloudflare/workers-oauth-provider`. Two open bugs stand between it and a working Claude.ai connector on a single Worker: DCR rejects Claude's registration body (#11081), and `requireMcpAuth` self-fetches the JWKS, which Workers block (#10888). Both have documented workarounds using lower-level exported functions.
3. **Inside an Effect `HttpApiMiddleware` the token is verified with `verifyJwsAccessToken` from `better-auth/oauth2`** (JWT, checked locally against the JWKS read in-process) and a browser session with `auth.api.getSession({ headers })`. `HttpApiSecurity.bearer` hands the middleware a `Redacted` credential; `HttpServerRequest` is available in the middleware's environment for the cookie path.
4. **Pin**: `better-auth@1.7.3`, `@better-auth/drizzle-adapter@1.7.3`, `@better-auth/mcp@1.7.3` (pulls `@better-auth/oauth-provider@1.7.3`), `auth@1.7.3` (the CLI; `@better-auth/cli` is stale at 1.4.21), `drizzle-orm@0.45.2`, `@modelcontextprotocol/server@2.0.0`. Tables: `user`, `session`, `account`, `verification`, `jwks`, `oauthClient`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`, plus the `oauthClientResource` link table.

## Versions checked (npm, 2026-09-08)

| Package | Latest | Note |
| --- | --- | --- |
| `better-auth` | 1.7.3 (published 2026-09-06) | `dist-tags.latest`; `npm view better-auth` |
| `@better-auth/drizzle-adapter` | 1.7.3 | separate package since the adapter split; `better-auth` 1.7.3 depends on it |
| `@better-auth/mcp` | 1.7.3 | depends on `@better-auth/oauth-provider@^1.7.3`, `jose@^6.1.3`; peers `better-auth@^1.7.3`, `@better-auth/core@^1.7.3`, `better-call@1.4.0` |
| `@better-auth/oauth-provider` | 1.7.3 | the OAuth 2.1 provider `mcp()` is built on |
| `@better-auth/cimd` | 1.7.3 | optional; exports `.` and `./node` |
| `auth` | 1.7.3 | "The CLI for Better Auth"; docs use `npx auth generate` |
| `@better-auth/cli` | 1.4.21 (2026-08-19) | stale; do not pin |
| `drizzle-orm` | 0.45.2 | `better-auth` peer range `^0.45.2 \|\| >=1.0.0-rc.1 <2.0.0` |
| `@modelcontextprotocol/server` | 2.0.0 (2026-07-28) | SDK v2; implements MCP 2026-07-28 |
| `@modelcontextprotocol/sdk` | 1.30.0 | SDK v1 line (2025-era protocol) |
| `@cloudflare/workers-oauth-provider` | 0.10.3 | the library the old app bypassed; for reference only |
| `effect` | 4.0.0-beta.102 | what slopcop pins in `pnpm-workspace.yaml` catalog |

## (a) Better Auth in a Cloudflare Worker with Drizzle on D1

### What the docs promise

- Better Auth is fetch-native: `auth.handler(request: Request): Promise<Response>`. The installation guide's `cloudflare-workers` tab mounts it as `if (url.pathname.startsWith("/api/auth")) return auth.handler(request)` inside `export default { fetch }` ([installation.mdx, "cloudflare-workers" tab](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/installation.mdx)). Hono is the same one-liner: `app.all("/api/auth/*", (c) => auth.handler(c.req.raw))` ([integrations/hono.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/integrations/hono.mdx)).
- **`nodejs_compat` (or `nodejs_als`) is required**: "Better Auth uses AsyncLocalStorage for async context tracking. To enable this in Cloudflare Workers, add the `nodejs_compat` flag" ([installation.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/installation.mdx), same text in [hono.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/integrations/hono.mdx)). Cloudflare's flag page confirms `nodejs_als` enables only AsyncLocalStorage ([compatibility-flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)).
- Drizzle adapter: `drizzleAdapter(db, { provider: "sqlite" })` from `@better-auth/drizzle-adapter`; pass `schema` when table names differ; `usePlural` supported ([adapters/drizzle.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/adapters/drizzle.mdx)). The database concept doc explicitly points D1 users at Drizzle: "If you're using Cloudflare D1 with Drizzle or Prisma, use `cloudflare:workers` to access `env`" ([concepts/database.mdx, "Programmatic Migrations"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/concepts/database.mdx)).
- Migrations: `getMigrations` (programmatic) "only works with the built-in Kysely adapter (SQLite/D1, ...). It does not work with Prisma or Drizzle ORM adapters, use CLI migrations with those ORMs instead" (same doc). So the flow is `npx auth generate` (emits the Drizzle schema for Better Auth's tables) then `drizzle-kit generate` and apply with `wrangler d1 migrations apply` ([adapters/drizzle.mdx, "Schema generation & migration"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/adapters/drizzle.mdx)).
- Better Auth's runtime deps are Workers-safe by construction: `jose`, `@noble/hashes`, `@noble/ciphers`, `kysely`, `better-call`, `zod` (`npm view better-auth@1.7.3 dependencies`).
- Cloudflare's own smoke tests exist upstream: PR #10834 "test(e2e): run Cloudflare smoke tests in workerd" and #10839 are merged (GitHub search, `repo:better-auth/better-auth cloudflare workers D1`).

### Caveats found in the source and issue tracker

1. **Date columns: use the CLI-generated `integer(..., { mode: "timestamp_ms" })`, never `text`.** The drizzle adapter sets `supportsUUIDs`, `supportsJSON`, `supportsArrays` but never `supportsDates`, so the factory default (`true`) applies and raw `Date` objects reach the driver. With a `text` date column D1 fails every write with `D1_TYPE_ERROR: Type 'object' not supported` ([#10816, open](https://github.com/better-auth/better-auth/issues/10816); confirmed in [drizzle-adapter.ts lines ~1176-1183 at v1.7.3](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/drizzle-adapter/src/drizzle-adapter.ts), which lists the three flags and no `supportsDates`). The fix PR [#10898](https://github.com/better-auth/better-auth/pull/10898) is open, unmerged. The CLI generator maps `date` to `integer('${name}', { mode: 'timestamp_ms' })` for sqlite ([cli/src/generators/drizzle.ts line 201 at v1.7.3](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/cli/src/generators/drizzle.ts)), which Drizzle converts to a number itself, so the generated schema avoids the bug. Keep it that way in the digital-shelf schema.
2. **Leave `transaction` off (its default).** `drizzleAdapter` only wraps calls in `db.transaction(...)` when `config.transaction` is true, default `false` ([drizzle-adapter.ts lines ~1195-1207](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/drizzle-adapter/src/drizzle-adapter.ts)). Drizzle's D1 driver implements `transaction()` by issuing literal `begin` / `commit` / `rollback` statements ([drizzle-orm/src/d1/session.ts](https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/d1/session.ts)), while D1 "operates in auto-commit" and only guarantees atomicity through `batch()` ([D1 Worker API, `batch()`](https://developers.cloudflare.com/d1/worker-api/d1-database/)). The same class of problem hits the SCIM plugin on D1, whose init hard-fails on a native-transaction requirement ([#10860, open](https://github.com/better-auth/better-auth/issues/10860)); the plugins in scope here (jwt, mcp/oauth-provider) are not reported to require one.
3. **Isolate-poisoning on aborted first request** ([#10315, open, updated 2026-09-07](https://github.com/better-auth/better-auth/issues/10315)): Better Auth caches init promises (`import("node:async_hooks")`, `auth.$context`) at module/instance level; on workerd a promise created during a request the client aborts never settles, and every later call in that isolate hangs before touching D1. Mitigation the reporter describes: initialize the instance eagerly and not from a client-driven request path (for example touch `auth.$context` in the fetch handler before routing, or from a warm-up request the app controls). No fix merged.
4. **`getMigrations()` on D1 failed with `SQLITE_AUTH` since 1.7** ([#10976, closed 2026-08-24](https://github.com/better-auth/better-auth/issues/10976)). Only relevant if the Kysely/D1 path is used instead of Drizzle; not our path.
5. **Schema validation at init** was added in 1.7.3 for Drizzle: "initialization-time schema validation and actionable mismatch guidance for Drizzle and Prisma adapters" (#11179, [v1.7.3 release notes](https://github.com/better-auth/better-auth/releases/tag/v1.7.3)). Good: a mismatched hand-written schema fails fast rather than at the first write.
6. **Per-request instance with bindings.** The docs' D1 example reads `env` via `import { env } from "cloudflare:workers"` at module scope ([concepts/database.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/concepts/database.mdx)). If the Effect layer constructs the Drizzle client from the `env.DB` binding instead, build the `betterAuth(...)` instance once per isolate from the same binding; recreating it per request re-runs the lazy init in point 3 on every request.
7. **`baseURL` drives everything OAuth.** Issuer, endpoint URLs and the default MCP resource all derive from the resolved base URL ([require-mcp-auth.ts](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/require-mcp-auth.ts) comment: "The provider stamps tokens with its resolved base URL (which includes the base path) as both issuer and default resource"). On Workers set `baseURL` explicitly from an env var rather than relying on header inference.

## (b) What `@better-auth/mcp` provides versus the connector requirements

The connector requirements are from `browser-worker/docs/rebuild/MCP.md` ("Authentication"): OAuth 2.1 per MCP spec 2025-06-18; RFC 9728 metadata at `/.well-known/oauth-protected-resource` plus `WWW-Authenticate` on 401; PKCE; RFC 7591 DCR "so Claude.ai can register without the user pasting a client id/secret"; `Authorization: Bearer` validated for audience binding (RFC 8707); one shared user pool with read-only scope.

`mcp()` "configures the OAuth provider with MCP resource binding and serves the RFC 9728 protected resource metadata"; "`mcp()` is the OAuth provider. Do not also register a separate `oauthProvider()` plugin" ([plugins/mcp.mdx at v1.7.3](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx)). The `jwt()` plugin is required: "it provides the stable signing key used for ID tokens and access tokens, and exposes the `/jwks` endpoint" (same doc). The older `mcp()` that shipped inside the `better-auth` package is deprecated in favour of this one (maintainer comment on [#9961](https://github.com/better-auth/better-auth/issues/9961): "We're planning to deprecate the MCP plugin soon and merge its functionality into the OAuth Provider plugin"; [#10713](https://github.com/better-auth/better-auth/issues/10713) documents that the old one lacks RFC 9207 `iss` while `@better-auth/oauth-provider` has it since 1.4.19).

| Requirement | Better Auth 1.7.3 | Source |
| --- | --- | --- |
| OAuth 2.1 with PKCE | Yes. `response_type=code` only, `code_challenge_method=plain` refused, PKCE always required for `token_endpoint_auth_method: "none"` clients (Claude is one), `iss` on all authorization responses (RFC 9207). | [oauth-provider.mdx "Authorize Endpoint", "PKCE Configuration"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx) |
| RFC 8414 AS metadata | Yes, at `{issuer}/.well-known/oauth-authorization-server` and the issuer-path-inserted alias. `registration_endpoint` is advertised only when DCR is enabled; `client_id_metadata_document_supported` only when `cimd()` is installed. | [mcp.mdx "Endpoints"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx); [oauth-provider.mdx "Confirm /.well-known endpoints"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx) |
| RFC 9728 protected-resource metadata | Yes. Served by the plugin's `onRequest` hook at `/.well-known/oauth-protected-resource` and at `/.well-known/oauth-protected-resource<resource path>` (both, from a `Set` of two paths). Document carries `resource`, `authorization_servers`, `scopes_supported`. | [mcp/src/plugin.ts lines ~196-232](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/plugin.ts) |
| `WWW-Authenticate` on 401 with `resource_metadata` | Yes. `createResourceServerChallenge` builds `Bearer ... resource_metadata="<origin>/.well-known/oauth-protected-resource<resource path>"`, optional `scope="..."`; 403 `insufficient_scope` for missing scopes. **Note it points at the path-inserted URL** (for `https://host/mcp` that is `/.well-known/oauth-protected-resource/mcp`). | [oauth-provider/src/resource-challenge.ts lines ~96-108, 182-187](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/oauth-provider/src/resource-challenge.ts) |
| RFC 7591 DCR | Supported but off by default: `allowDynamicClientRegistration: true` + `allowUnauthenticatedClientRegistration: true`. "MCP deprecates Dynamic Client Registration (DCR), so Better Auth never enables DCR implicitly." `mcp()` appends its `resource` to `clientRegistrationDefaultResources` so a DCR client with no `resources` field is still linked to the MCP resource. | [mcp.mdx "Optional DCR fallback"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx); [plugin.ts lines ~176-186](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/plugin.ts) |
| RFC 8707 audience-bound tokens | Yes. `resource` becomes the JWT `aud`: "With the JWT plugin enabled (default), sending `resource` results in a JWT access token with the selected resource in the `aud` claim." `requireMcpAuth` / `createMcpProtectedRequestHandler` verify `issuer` and `audience` (= the full resource URL) via `jose`. | [oauth-provider.mdx "Token Endpoint"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx); [mcp/src/handler.ts lines ~612-645](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/handler.ts) |
| Bearer on every request | Yes; `requestToResourceInput` reads `Authorization` (and `DPoP`) from a standard `Request`. | [oauth-provider.mdx "API Server / Verification"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx) |
| Streamable HTTP transport | Not Better Auth's job. The docs pair it with `createMcpHandler` from `@modelcontextprotocol/server` v2 and wrap the POST with `requireMcpAuth`. The SDK's serving guide: "On a web-standard runtime, Cloudflare Workers, Deno, Bun, `export default handler` is the entire mount", and the handler "verifies no token; mount both checks in front of it", passing claims as `handler.fetch(request, { authInfo })`. | [mcp.mdx "Protecting an MCP Route"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx); [SDK v2 serving guide](https://ts.sdk.modelcontextprotocol.io/v2/serving/http) |
| Single shared user pool, read-only scope | Yes by construction: consent runs against Better Auth's own `user`/`session`; scopes are declared on `mcp({ scopes })` / `resources[].allowedScopes` and enforced with `requiredScopes`. | [mcp.mdx "Configuration"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx); [oauth-provider.mdx "Resources"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx) |

### Why the old app bypassed the Cloudflare library, and whether Better Auth has the same problem

`browser-worker/mcp/src/oauth/handlers.ts` (header comment): "The current Cloudflare OAuth provider library validates token audience against only the request origin, while Claude's MCP flow uses the full `/mcp` resource URL. Owning the OAuth exchange here lets the protected resource metadata stay standards-aligned." `provider.ts` adds that the library "does not emit RFC 9728 metadata", and `www-authenticate-rewriter.ts` exists to inject `resource_metadata` into the library's 401.

Better Auth does not share that assumption. `mcp({ resource: "https://mcp.example/mcp" })` validates the resource as an HTTPS URL with path allowed (no query/fragment/credentials; [handler.ts `validateMcpResource`](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/handler.ts)), stamps it as `aud`, serves RFC 9728 itself, and emits the `resource_metadata` challenge itself. The MCP spec's canonical-URI examples include `https://mcp.example.com/mcp` and require servers to "validate that access tokens were issued specifically for them as the intended audience, according to RFC 8707 Section 2" ([2025-06-18 authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)). So the specific reason for hand-rolling OAuth goes away.

### Blockers and risks for the Claude.ai connector, in priority order

1. **DCR rejects Claude's registration body** ([#11081, open, "needs: discussion"](https://github.com/better-auth/better-auth/issues/11081)). Claude registers with `grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"]` and `token_endpoint_auth_method: "none"`, and 1.7.2 answers `400 invalid_client_metadata: unsupported grant_type urn:ietf:params:oauth:grant-type:jwt-bearer`. A maintainer states the policy on 2026-09-04: "DCR: reject metadata containing unsupported values. CIMD: accept metadata when at least one value is supported... Relaxing DCR validation requires an explicit policy decision." No fix in 1.7.3. Claude's published client-metadata document ([https://claude.ai/oauth/mcp-oauth-client-metadata](https://claude.ai/oauth/mcp-oauth-client-metadata), fetched 2026-09-08) declares the same grant union, `redirect_uris: ["https://claude.ai/api/mcp/auth_callback"]`, `response_types: ["code"]`, `token_endpoint_auth_method: "none"`.
   - Path A (spec-preferred): install `@better-auth/cimd`. The grant-intersection fix for CIMD is merged (#10731 to `next` 2026-08-18, backport [#11010](https://github.com/better-auth/better-auth/pull/11010) to `main` 2026-08-26, before the v1.7.3 tag of 2026-09-06; I did not diff the 1.7.3 CHANGELOG line by line). MCP 2026-07-28 says clients "SHOULD use Client ID Metadata Documents if the Authorization Server indicates that it supports them" and fall back to DCR ([client-registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration)). **But** `cimd()` requires a `fetchClientMetadataResource` transport that resolves DNS once, rejects RFC 6890 addresses, pins the address and refuses redirects; the bundled `@better-auth/cimd/node` imports `node:dns/promises`, `node:https`, `node:net` ([cimd/src/node.ts](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/cimd/src/node.ts)) and the docs say "Bun, Deno, Workers, and other runtimes must provide the equivalent secure transport" and "Do not perform a DNS check and then call `globalThis.fetch`" ([plugins/cimd.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/cimd.mdx)). Workers `fetch` cannot pin a resolved address, so the documented contract cannot be met literally on Workers. A pragmatic Worker transport is `fetch(url, { redirect: "error" })` restricted by `isMetadataDocumentUrlAllowed` to an allowlist (for this app: `claude.ai`), accepting that DNS-rebinding protection then rests on the allowlist rather than on pinning.
   - Path B: keep DCR and pre-filter `grant_types` before Better Auth sees the body. Better Auth's `onRequest` hook or the Effect router can rewrite `POST /oauth2/register` bodies to the supported intersection (RFC 7591 §2 lets the server "replace any of the client's requested metadata values"). Same trick the #10900 reporter used for CIMD ("We currently wrap `fetchClientMetadataResource` to filter `grant_types`").
   - Path C: pre-register Claude as a public client (`token_endpoint_auth_method: "none"`, its redirect URI) via `auth.api.createOAuthClient` and let users paste the `client_id` into Claude.ai's Advanced settings, the fallback MCP.md already names.
2. **`requireMcpAuth` self-fetches `/jwks` and 500s on a single Worker** ([#10888, open](https://github.com/better-auth/better-auth/issues/10888); fix PR [#10893](https://github.com/better-auth/better-auth/pull/10893) open, unmerged as of 2026-09-08). Reproduced on "Cloudflare Workers (custom domain), D1 via the drizzle adapter" with 1.7.1. Cause is visible in 1.7.3 source: `const jwksUrl = opts?.jwksUrl ?? \`${baseURL}/jwks\`` and `McpProtectedRequestHandlerOptions.jwksUrl?: string` only ([require-mcp-auth.ts](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/require-mcp-auth.ts), [handler.ts](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/handler.ts)); Cloudflare documents that "Using global `fetch()` to call another Worker on the same zone without service bindings fails" ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). Workaround from the issue, which also removes the HTTP hop and is what section (c) builds on: call `verifyJwsAccessToken(token, { verifyOptions: { issuer, audience }, jwksFetch: async () => (await auth.handler(new Request(\`${baseURL}/jwks\`))).json(), jwksCacheKey })`. `verifyJwsAccessToken` accepts `jwksFetch: string | (() => Promise<JSONWebKeySet | undefined>)` and `jwksCacheKey?: object` ([core/src/oauth2/verify.ts lines 45-51, 235](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/core/src/oauth2/verify.ts)); `createResourceServerChallenge` from `@better-auth/oauth-provider` builds the 401/403 headers ([mcp.mdx "Protected Resource Metadata"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx)).
3. **Path-inserted `resource_metadata` URL.** Better Auth's challenge points Claude at `/.well-known/oauth-protected-resource/mcp` ([resource-challenge.ts line ~108](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/oauth-provider/src/resource-challenge.ts)). The old app's `protected-resource.ts` records that "the path-suffixed `/.well-known/oauth-protected-resource/mcp` variant introduced during the rebuild caused the connector validator to bail with a generic 'Couldn't reach the MCP server' error" and pinned the root URL. Better Auth serves both URLs, but the header is not configurable by option in 1.7.3 (the mapping option `resourceMetadataMappings` only covers non-URL resources). If Claude's validator still trips, set `resource` to the origin (`https://mcp.example`) so the path is empty and the header points at the root, or rewrite the header at the router boundary the way `www-authenticate-rewriter.ts` did.
4. **Well-known paths must reach `auth.handler`.** "If your framework only forwards requests under a catch-all auth route, make sure the issuer metadata URLs reach `auth.handler`" ([oauth-provider.mdx "Confirm /.well-known endpoints"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx)). The Effect router must forward `/.well-known/oauth-authorization-server*`, `/.well-known/oauth-protected-resource*` and (if `openid` scope) `/.well-known/openid-configuration` to Better Auth, not just `/api/auth/*`.
5. **Protocol era.** The Better Auth docs target MCP 2026-07-28 with `createMcpHandler(..., { legacy: "reject" })` and SDK v2. MCP.md was written against 2025-06-18 (session-oriented Streamable HTTP). 2026-07-28 removed protocol-level sessions and made every message an independent POST ([2026-07-28 streamable-http](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http): "Revision 2026-07-28 changed the behavior of Streamable HTTP... Removal of protocol-level sessions"), with a backward-compatibility matrix for older clients ([transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)). Anthropic's platform MCP-connector doc still links the 2025-11-25 authorization spec and says it "supports both Streamable HTTP and SSE transports" ([mcp-connector](https://platform.claude.com/docs/en/agents-and-tools/mcp-connector)). I could not verify which revision Claude.ai's consumer connector speaks today (see unverified). Do not set `legacy: "reject"` until that is checked; SDK v2 detects the counterpart's era and falls back when allowed.
6. **JWT plugin in provider mode.** "You MUST disable the `/token` endpoint... and disable setting the jwt header": `disabledPaths: ["/token"]` and `jwt({ disableSettingJwtHeader: true })` ([plugins/jwt.mdx "OAuth Provider Mode"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/jwt.mdx)). Default signing is EdDSA/Ed25519 with the private key AES-256-GCM-encrypted in the `jwks` table (same doc); `jose` handles both on Workers.
7. **Split-origin discovery is pinned to `baseURL`** ([#9961, open](https://github.com/better-auth/better-auth/issues/9961), reported against the old in-package `mcp()`); only matters if the auth server and the MCP resource are on different hosts. For the single-Worker design it does not.
8. **DPoP replay store** defaults to the database adapter in `requireMcpAuth` ("so anti-replay holds across multiple server instances", [require-mcp-auth.ts](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/require-mcp-auth.ts)); `verifyAccessTokenRequest` on its own "defaults to an in-memory `jti` store that is safe only for a single instance" ([oauth-provider.mdx "Verification" callout](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx)). Claude does not send DPoP proofs (its metadata declares none), so this is moot until a DPoP client appears; if the lower-level workaround in (2) is used, pass `dpop.replayStore: createDpopReplayStore(ctx.internalAdapter)` anyway.

## (c) Verifying a Better Auth identity inside an Effect `HttpApiMiddleware`

### How slopcop does it (the pattern to copy)

`packages/api/src/LabelingRules/Security.ts` declares the scheme and the middleware service:

```ts
export const LabelingAdminAccessIdentity = HttpApiSecurity.apiKey({ in: "header", key: "x-slopcop-access-sub" })

export class LabelingAdminMiddleware extends HttpApiMiddleware.Service<
  LabelingAdminMiddleware,
  { provides: LabelingAdminIdentity }
>()("@slopcop/api/LabelingAdminMiddleware", {
  error: Unauthenticated,                       // Schema.TaggedErrorClass with httpApiStatus: 401
  security: { access: LabelingAdminAccessIdentity },
}) {}
```

and `apps/api/src/Labeling/httpapi/Security.ts` implements it as a `Layer.effect(LabelingAdminMiddleware, Effect.succeed({ access: Effect.fnUntraced(function* (httpEffect, { credential }) { ... return yield* httpEffect.pipe(Effect.provideService(LabelingAdminIdentity, {...})) }) }))`, then `Layer.provide(LabelingAdminMiddlewareLayer)` on each `HttpApiBuilder.group(...)` (`apps/api/src/Activity/httpapi/Handlers.ts`). The endpoint groups attach the middleware in `packages/api/src/*/…Api.ts`.

Effect 4's contract for a security middleware handler is one function per scheme key receiving `(httpEffect, { credential, endpoint, group })`, where `credential` is `HttpApiSecurity.Type<Security[K]>` and the returned effect may require `Requires | HttpRouter.Provided` ([HttpApiMiddleware.ts, `HttpApiMiddlewareSecurity`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/httpapi/HttpApiMiddleware.ts)). `HttpRouter.Provided` includes `HttpServerRequest.HttpServerRequest` ([HttpRouter.ts `Provided`](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/http/HttpRouter.ts)), so the raw headers are reachable inside the middleware. `HttpApiSecurity.bearer` is `http({ scheme: "Bearer" })` and yields a `Redacted` credential; `apiKey({ in: "cookie", key })` also yields `Redacted` ([HttpApiSecurity.ts](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/httpapi/HttpApiSecurity.ts)).

### MCP bearer tokens (JWT access tokens issued by `mcp()`)

Verify locally, in-process, no network call (avoids #10888 and the per-request HTTP hop):

```ts
import { verifyJwsAccessToken } from "better-auth/oauth2"
import { createResourceServerChallenge } from "@better-auth/oauth-provider"

export const McpMiddlewareLayer = Layer.effect(
  McpMiddleware,                         // HttpApiMiddleware.Service with security: { bearer: HttpApiSecurity.bearer }
  Effect.gen(function* () {
    const auth = yield* BetterAuth       // a Context.Service wrapping the betterAuth() instance
    const jwksCacheKey = {}              // stable object => verifyJwsAccessToken caches the key set per isolate
    return {
      bearer: Effect.fnUntraced(function* (httpEffect, { credential }) {
        const claims = yield* Effect.tryPromise({
          try: () => verifyJwsAccessToken(Redacted.value(credential), {
            verifyOptions: { issuer: auth.baseURL, audience: auth.mcpResource },
            jwksFetch: async () => {
              const res = await auth.instance.handler(new Request(`${auth.baseURL}/jwks`))
              return res.ok ? res.json() : undefined
            },
            jwksCacheKey,
          }),
          catch: (error) => new Unauthenticated({ message: "invalid or expired MCP access token", cause: error }),
        })
        // claims.sub is the Better Auth user id; claims.scope is the space-separated scope string
        return yield* httpEffect.pipe(Effect.provideService(McpIdentity, { userId: claims.sub!, scopes: String(claims.scope ?? "").split(" ") }))
      }),
    }
  }),
)
```

Sources: `verifyJwsAccessToken(token, { verifyOptions, jwksFetch, jwksCacheKey })` signature and caching behaviour ([core/src/oauth2/verify.ts](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/core/src/oauth2/verify.ts)); the in-process `auth.handler` JWKS trick is the workaround the #10888 reporter shipped and the approach PR #10893 adopts ("resolves the key set in-process via the auth instance's JWT plugin"). The JWT `sub` is the user id by default ([jwt.mdx "Modify Issuer, Audience, Subject"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/jwt.mdx)).

Two details the 401 must get right for Claude to start the flow:
- Effect's security middleware turns a missing `Authorization` header into the declared error automatically, but the response must carry `WWW-Authenticate: Bearer resource_metadata="..."` (MCP spec: "MCP servers MUST use the HTTP header `WWW-Authenticate` when returning a 401"). Build it with `createResourceServerChallenge(error, resource, { challengeScopes })` and attach it to the `Unauthenticated` response (for example with `HttpApiBuilder.middleware` post-processing or by encoding the header in the error's `httpApiStatus` handler). The old app also needed `Access-Control-Expose-Headers: WWW-Authenticate` and a 204 preflight for `/mcp` so Claude's browser-side validator can read the header (`protected-resource.ts` comments); keep both.
- Do not use `verifyBearerToken` if DPoP tokens are ever accepted: "It rejects DPoP-bound tokens, so prefer `verifyAccessTokenRequest`" ([oauth-provider.mdx "Verification"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx)).

### Browser sessions (the dashboard)

Better Auth's session is an opaque cookie named `${prefix}.session_token`, prefix `better-auth` by default, secure in production ([concepts/cookies.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/concepts/cookies.mdx)). Verification is `auth.api.getSession({ headers })`, which returns `{ user, session } | null` ([hono.mdx "Middleware"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/integrations/hono.mdx)). Inside an Effect middleware, read `HttpServerRequest` from the environment and pass its headers (`new Headers(request.headers)`) so Better Auth sees the cookie unchanged; declaring the scheme as `HttpApiSecurity.apiKey({ in: "cookie", key: "better-auth.session_token" })` documents it in OpenAPI but the cookie name changes with `useSecureCookies` (`__Secure-` prefix), so passing the whole header set is the robust path. With the `bearer()` plugin the same session token is also accepted as `Authorization: Bearer <session token>` ("as long as the Authorization Bearer token header is present", [plugins/bearer.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/bearer.mdx)); that is useful for the dashboard's own fetches but must not be enabled on the `/mcp` route, where only `mcp()`-issued JWTs should be accepted (MCP spec: "MCP servers MUST NOT accept or transit any other tokens").

Performance: `getSession` is one D1 round trip per request (joins on with `advanced.database.joins: true`, [adapters/drizzle.mdx "Joins"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/adapters/drizzle.mdx)); the JWT path is zero round trips after the first JWKS read per isolate.

## (d) Plugins, versions, and the tables they add

### Plugins to install

| Plugin | Package / import | Required? | Why |
| --- | --- | --- | --- |
| Drizzle adapter | `drizzleAdapter` from `@better-auth/drizzle-adapter@1.7.3` | yes | D1 via `drizzle-orm/d1`, `provider: "sqlite"` |
| JWT | `jwt` from `better-auth/plugins` (bundled) | yes | "The JWT plugin is required" by `mcp()`; configure `disabledPaths: ["/token"]`, `jwt({ disableSettingJwtHeader: true })` |
| MCP | `mcp` from `@better-auth/mcp@1.7.3` | yes | OAuth 2.1 AS + RS metadata + resource binding; `loginPage`, `consentPage`, `resource` are required options |
| OAuth provider | `@better-auth/oauth-provider@1.7.3` | transitive | dependency of `@better-auth/mcp`; import `createResourceServerChallenge` from it |
| CIMD | `cimd` from `@better-auth/cimd@1.7.3` | optional | only if Path A above is chosen; needs a Worker transport |
| Bearer | `bearer` from `better-auth/plugins` | optional | session-token-as-bearer for the dashboard's own API calls |
| CLI | `auth@1.7.3` (`npx auth generate`) | dev | emits the Drizzle schema for all installed plugins |

Config essentials on Workers: `baseURL` explicit; `trustedOrigins` for the dashboard origin; `compatibility_flags: ["nodejs_compat"]`; `advanced.backgroundTasks.handler` wired to `ctx.waitUntil` if back-channel logout is ever used ([oauth-provider.mdx "Back-Channel Logout"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx)).

### Tables Better Auth adds to the Drizzle schema

Core ([concepts/database.mdx "Core Schema"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/concepts/database.mdx)):

- `user`: `id` PK, `name`, `email` unique, `emailVerified` boolean, `image?`, `createdAt`, `updatedAt`
- `session`: `id` PK, `userId` FK, `token` unique, `expiresAt`, `ipAddress?`, `userAgent?`, `createdAt`, `updatedAt`
- `account`: `id` PK, `userId` FK, `accountId`, `providerId`, `accessToken?`, `refreshToken?`, `accessTokenExpiresAt?`, `refreshTokenExpiresAt?`, `scope?`, `idToken?`, `password?`, `createdAt`, `updatedAt`
- `verification`: `id` PK, `identifier`, `value`, `expiresAt`, `createdAt`, `updatedAt`

JWT plugin ([plugins/jwt.mdx "Schema"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/jwt.mdx)):

- `jwks`: `id` PK, `publicKey`, `privateKey` (encrypted), `createdAt`, `expiresAt?`

OAuth provider / MCP ([oauth-provider.mdx "Schema"](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx); "The MCP plugin uses the same schema as the OAuth Provider plugin", [mcp.mdx](https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx)):

- `oauthClient`: `id` PK, `clientId`, `clientSecret?`, `disabled?`, `skipConsent?`, `enableEndSession?`, `subjectType?`, `scopes?` string[], `userId?` FK, `referenceId?`, `createdAt?`, `updatedAt?`, `name?`, `uri?`, `icon?`, `contacts?` string[], `tos?`, `policy?`, `softwareId?`, `softwareVersion?`, `softwareStatement?`, `redirectUris` string[], `postLogoutRedirectUris?` string[], `backchannelLogoutUri?`, `backchannelLogoutSessionRequired?`, `tokenEndpointAuthMethod?`, `grantTypes?` string[], `responseTypes?` string[], `applicationType?`, `clientDiscoveryId?` (set to `"cimd"` for discovered clients), `requirePKCE?`, `dpopBoundAccessTokens?`, `metadata?` json
- `oauthRefreshToken`: `id` PK, `token`, `clientId` FK, `sessionId?` FK, `userId` FK, `referenceId?`, `scopes` string[], `revoked?`, `rotatedAt?`, `rotationReplayResponse?`, `rotationReplayExpiresAt?`, `authTime?`, `createdAt`, `expiresAt`, `confirmation?` json
- `oauthAccessToken`: `id` PK, `token`, `clientId` FK, `sessionId?` FK, `refreshId?` FK, `userId?` FK, `referenceId?`, `scopes` string[], `createdAt`, `expiresAt`, `confirmation?` json, `revoked?`
- `oauthConsent`: `id` PK, `userId` FK, `clientId` FK, `referenceId?`, `scopes` string[], `requestedUserInfoClaims?` string[], `createdAt`, `updatedAt`
- `oauthClientAssertion`: `id` PK, `expiresAt` (replay store for `private_key_jwt` / DPoP `jti`)
- `oauthClientResource`: link rows between clients and resources; referenced in the docs ("otherwise add a row to the `oauthClientResource` table"; "create the corresponding `oauthClientResource` links atomically") but not listed in the Schema section. Run `npx auth generate` and take the emitted definition as authoritative.

On sqlite the CLI emits `string[]`/`json` fields as `text` with JSON encoding (the adapter reports `supportsJSON: false` and `supportsArrays: false` for non-pg providers, [drizzle-adapter.ts](https://github.com/better-auth/better-auth/blob/v1.7.3/packages/drizzle-adapter/src/drizzle-adapter.ts)) and dates as `integer(..., { mode: "timestamp_ms" })`.

## Recommendation for the rebuild

Use Better Auth 1.7.3 with the Drizzle-D1 adapter and `jwt()` + `mcp()` as the single authorization server and resource server in the API Worker. Route `/api/auth/*` and `/.well-known/*` to `auth.handler`; protect `/mcp` with an Effect security middleware that verifies the JWT in-process (section c) and emits the RFC 9728 challenge, instead of `requireMcpAuth` until #10893 ships. For client registration, plan on Path B (DCR with a `grant_types` intersection shim) as the day-one path because MCP.md's flow and Claude's connector were verified against DCR, and keep Path A (CIMD with an allowlisted Worker transport) as the follow-up once Claude.ai's use of CIMD is confirmed. Keep the CLI-generated schema's `timestamp_ms` columns and the adapter's default `transaction: false`. Re-check #10816, #10888/#10893, #11081 and #10315 before pinning; a 1.7.4 that merges #10893 and #10898 removes two of the shims.

## Not verified

- **What Claude.ai's consumer connector actually sends today** (protocol revision, whether it tries CIMD before DCR, whether it accepts the path-inserted `resource_metadata` URL). The support article "Building custom connectors via remote MCP servers" is rendered client-side and could not be fetched; the platform docs describe the API-side connector, not claude.ai. Evidence used instead: MCP.md's verified-against-Claude notes, Claude's live client-metadata document, and Better Auth issues #11081/#10900 that quote Claude's DCR body.
- **That #11010 (CIMD grant intersection) is in the published 1.7.3 tarball.** It merged to `main` on 2026-08-26 and 1.7.3 was tagged 2026-09-06; I did not diff the package CHANGELOG.
- **End-to-end behaviour on workerd.** Nothing was executed; all runtime claims come from upstream issues, docs and source.
- **Whether `auth.api.getSession` works with `HttpServerRequest` headers without adaptation** (Effect's `Headers` type versus the Fetch `Headers` Better Auth expects). Expect a `new Headers(...)` conversion.
- **`@modelcontextprotocol/server` 2.0.0 on Workers beyond the SDK doc's statement** that web-standard runtimes mount `export default handler` directly; its `package.json` declares `engines.node >= 20` and the README asks for `"types": ["node"]`.
- **CIMD transport security on Workers**: no primary source describes a Workers transport that meets the pinning contract; the allowlist approach is my inference from the docs' stated threat model.

## Sources

Better Auth (docs source at tag v1.7.3 unless noted):
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/mcp.mdx (identical on `main` as of 2026-09-08)
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/oauth-provider.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/cimd.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/jwt.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/plugins/bearer.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/adapters/drizzle.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/concepts/database.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/concepts/cookies.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/installation.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/docs/content/docs/integrations/hono.mdx
- https://github.com/better-auth/better-auth/blob/v1.7.3/packages/mcp/src/{plugin,handler,require-mcp-auth}.ts
- https://github.com/better-auth/better-auth/blob/v1.7.3/packages/oauth-provider/src/resource-challenge.ts
- https://github.com/better-auth/better-auth/blob/v1.7.3/packages/core/src/oauth2/verify.ts
- https://github.com/better-auth/better-auth/blob/v1.7.3/packages/drizzle-adapter/src/drizzle-adapter.ts
- https://github.com/better-auth/better-auth/blob/v1.7.3/packages/cli/src/generators/drizzle.ts
- https://github.com/better-auth/better-auth/blob/v1.7.3/packages/cimd/src/node.ts
- https://github.com/better-auth/better-auth/releases/tag/v1.7.3
- Issues/PRs: #10816, #10898, #10888, #10893, #10315, #10860, #10976, #11081, #10900, #10731, #11010, #9961, #10713, #10553, #10834
- npm: `npm view` for better-auth, @better-auth/{mcp,cimd,oauth-provider,drizzle-adapter,cli}, auth, drizzle-orm, @modelcontextprotocol/{server,sdk,node}, @cloudflare/workers-oauth-provider

MCP and Claude:
- https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization and /authorization/client-registration
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports and /transports/streamable-http
- https://ts.sdk.modelcontextprotocol.io/v2/serving/http
- https://claude.ai/oauth/mcp-oauth-client-metadata (fetched 2026-09-08)
- https://platform.claude.com/docs/en/agents-and-tools/mcp-connector

Cloudflare and Drizzle:
- https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://github.com/drizzle-team/drizzle-orm/blob/main/drizzle-orm/src/d1/session.ts

Effect and local code:
- https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/httpapi/{HttpApiSecurity,HttpApiMiddleware}.ts and /unstable/http/HttpRouter.ts
- `.repos/slopcop/packages/api/src/LabelingRules/Security.ts`, `.repos/slopcop/apps/api/src/Labeling/httpapi/Security.ts`, `.repos/slopcop/apps/api/src/Activity/httpapi/Handlers.ts`, `.repos/slopcop/pnpm-workspace.yaml`
- `browser-worker/docs/rebuild/MCP.md` ("Authentication"), `browser-worker/mcp/src/oauth/{handlers,provider,protected-resource,www-authenticate-rewriter,clients,store}.ts`
