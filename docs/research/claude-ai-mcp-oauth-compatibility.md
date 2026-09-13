Research status: COMPLETE

# Claude.ai registration, token lifecycle, and same-Worker OAuth verification

- **Ticket:** [Verify Claude.ai registration, token lifecycle and same-Worker OAuth verification](https://github.com/NicePakProducts/effect-digital-shelf/issues/94)
- **Research date:** 2026-09-13 UTC
- **Digital Shelf source:** `prototype/listing-workspace` at [`1eb7fa2af407c65c12a7af7325caa9dedb77d4e4`](https://github.com/NicePakProducts/effect-digital-shelf/tree/1eb7fa2af407c65c12a7af7325caa9dedb77d4e4)
- **Provider source:** Better Auth / `@better-auth/mcp` / `@better-auth/oauth-provider` **1.7.3**, upstream tag [`v1.7.3` = `597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d`](https://github.com/better-auth/better-auth/tree/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d). The repository lockfile pins all three to 1.7.3 ([`bun.lock:303-309,1179`](https://github.com/NicePakProducts/effect-digital-shelf/blob/1eb7fa2af407c65c12a7af7325caa9dedb77d4e4/bun.lock#L303-L309)).
- **Starting evidence:** [Better Auth on Workers and MCP OAuth findings](https://github.com/NicePakProducts/effect-digital-shelf/issues/5#issuecomment-5581316777) and the agreed scope in `docs/research/mcp-oauth-cloudflare-code-mode.md`. This report examines only the unresolved Better Auth/Claude seams.

Remote material was read as data and not executed. No checkout files were changed, no dependency was installed, and no deployed OAuth or Claude.ai exchange was run.

## Bottom line

Pinned Better Auth remains the right single authorization server, but it is **not stock-compatible with the presently evidenced Claude registration shape or a same-Worker JWKS lookup**:

1. Enable both open-DCR switches and restrict the provider itself to authorization-code plus refresh grants.
2. Add one narrow registration-policy adapter before Better Auth. Pinned 1.7.3 intentionally rejects DCR when Claude's known grant union includes unsupported `jwt-bearer`; it only applies intersection behavior to CIMD.
3. Add one narrow protected-request adapter using Better Auth's verifier and an in-process JWKS callback. Pinned `requireMcpAuth` always self-fetches a URL; proposed fix #10893 was closed unmerged and is absent from 1.7.3.
4. Configure 900-second access tokens, 2,592,000-second rotating refresh tokens, and request `offline_access`. Rotation in 1.7.3 is **sliding**, not an absolute 30-day family lifetime.
5. The provider has session-authenticated, per-User consent list/delete endpoints, but deleting consent does **not** revoke refresh families. An application-owned grant revocation operation must delete the User/client consent and refresh family and coordinate with in-flight token minting. Putting the deletes in one transaction alone is not proof that concurrent refresh/code exchange cannot recreate tokens. Locally verified JWT access tokens cannot observe database revocation and an already-issued token remains usable until its 15-minute TTL expires.

These are adapters around the pinned provider, not grounds for a second issuer or a handwritten OAuth/token implementation.

# Verified facts

## 1. Claude evidence and the precise registration incompatibility

Anthropic's current connector documentation says Claude supports Streamable HTTP, the 2025-03-26/2025-06-18/2025-11-25 auth specifications, DCR, the hosted callback `https://claude.ai/api/mcp/auth_callback`, token refresh/expiry, and custom credentials when DCR is unavailable ([official Claude.ai “Building custom connectors”](https://claude.com/docs/connectors/building)). It does **not** publish the exact DCR HTTP body.

Claude's live, first-party client metadata document returned this exact shape during research:

```json
{
  "client_id": "https://claude.ai/oauth/mcp-oauth-client-metadata",
  "client_name": "Claude",
  "client_uri": "https://claude.ai",
  "redirect_uris": ["https://claude.ai/api/mcp/auth_callback"],
  "grant_types": [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer"
  ],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

Source: [`https://claude.ai/oauth/mcp-oauth-client-metadata`](https://claude.ai/oauth/mcp-oauth-client-metadata), fetched 2026-09-13 (HTTP 200, `application/json`). This proves Claude's currently published **CIMD** metadata, not that its DCR request is byte-for-byte identical.

Better Auth issue [#11081](https://github.com/better-auth/better-auth/issues/11081) reports a captured Claude DCR request using authorization code, refresh token, and `jwt-bearer`; the issue remains open. Pinned 1.7.3 has the related CIMD backport [#11010](https://github.com/better-auth/better-auth/pull/11010), but source and a regression test explicitly preserve strict DCR behavior: a CIMD succeeds if any requested grant is supported, while DCR rejects every unsupported member ([`register.ts:410-431`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/register.ts#L410-L431), [`register.test.ts:543-590`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/register.test.ts#L543-L590)). Therefore the reported Claude DCR union fails pinned 1.7.3 with `invalid_client_metadata` even though its two needed grants are supported.

RFC 7591 permits an authorization server to replace requested client metadata with suitable values and return the actual registered values ([RFC 7591 §3.2.1](https://www.rfc-editor.org/rfc/rfc7591.html#section-3.2.1)). That permits narrowing, but does not make generic “silently drop everything unknown” a safe application policy.

## 2. DCR switches, advertised capabilities, and automatic credentials

The current Digital Shelf config supplies only login page, consent page, and resource ([`packages/core/src/Auth/Auth.ts:45-49`](https://github.com/NicePakProducts/effect-digital-shelf/blob/1eb7fa2af407c65c12a7af7325caa9dedb77d4e4/packages/core/src/Auth/Auth.ts#L45-L49)). Both DCR options default false; the provider default grants also include unintended `client_credentials` ([`oauth.ts:216-228`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/oauth.ts#L216-L228)). URL-only unauthenticated Claude setup therefore requires:

```ts
allowDynamicClientRegistration: true,
allowUnauthenticatedClientRegistration: true,
grantTypes: ["authorization_code", "refresh_token"],
```

The registration endpoint is advertised only with the first switch ([`metadata.ts:43-56`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/metadata.ts#L43-L56)); an unauthenticated request is admitted only with the second (or a valid initial access token/session) ([`register.ts:248-305`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/register.ts#L248-L305)). Open DCR already refuses unauthenticated `client_credentials`, but explicitly removing it from `grantTypes` also removes the misleading advertised capability.

URL-only does **not** mean public client. If registration says `token_endpoint_auth_method: "none"`, Better Auth stores a public client. Otherwise the DCR default is `client_secret_basic`; Better Auth generates and returns a one-time secret automatically ([`register.ts:83-97`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/register.ts#L83-L97), [`register.ts:766-835`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/register.ts#L766-L835)). Provider-supported methods are `none`, `client_secret_basic`, `client_secret_post`, and `private_key_jwt` ([`extensions.ts:25-40,275-291`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/extensions.ts#L25-L40)). Claude's current published metadata asks for `none`, but a live DCR trace is still needed before rejecting automatically provisioned confidential credentials as incompatible.

The `mcp()` wrapper delegates all OAuth options, defaults refresh reuse to 30 seconds, adds the MCP URL as a provider resource and as the dynamic-client default resource ([`packages/mcp/src/plugin.ts:170-187`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/mcp/src/plugin.ts#L170-L187)). Registration scope metadata is only a client capability: Better Auth documents that it neither narrows the persisted operator-approved capability set nor grants scopes to a User ([`types/index.ts:774-799`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/types/index.ts#L774-L799)). All DCR names, URIs, icons, and other metadata are self-asserted; the provider explicitly documents the incoming metadata as self-asserted ([`types/index.ts:734-748`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/types/index.ts#L734-L748)).

### Limits of provider-native registration safeguards

Pinned Better Auth usefully validates redirect form, grant/auth-method support, response/grant consistency, client resources/scopes, and PKCE policy. Open DCR additionally blocks `client_credentials`. It does **not** establish that `client_name: "Claude"` belongs to Anthropic, restrict HTTPS redirects to Claude's one hosted callback, or understand that only the known `jwt-bearer` surplus should be narrowed. Those remain application policy. Generic intersection filtering would turn future, unexpected metadata into accepted registrations and hide compatibility changes; strict rejection is the safer default outside the one evidenced Claude union.

## 3. Same-Worker JWKS verification is still broken in the pin

Pinned `requireMcpAuth` resolves `${baseURL}/jwks` and passes only that URL to the protected handler ([`require-mcp-auth.ts:94-130`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/mcp/src/require-mcp-auth.ts#L94-L130)). Its public options and lower handler accept only a string `jwksUrl`; the handler otherwise correctly fixes issuer and audience, enforces scopes, and creates 401/403 challenges ([`handler.ts:14-51,127-169`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/mcp/src/handler.ts#L14-L51)).

Issue [#10888](https://github.com/better-auth/better-auth/issues/10888) reproduces the resulting Cloudflare same-host self-fetch failure. PR [#10893](https://github.com/better-auth/better-auth/pull/10893) proposed an in-process JWKS callback and cache key, but it is **closed, unmerged**, and its changes are absent from tag 1.7.3. Upgrading to 1.7.3 does not solve this seam.

Better Auth's own revocation implementation demonstrates the correct local-key pattern: obtain the JWT plugin's JWKS in process, cache it under the stable plugin object, then verify with the configured issuer ([`revoke.ts:46-80`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/revoke.ts#L46-L80)). Digital Shelf can use the exported lower-level `verifyJwsAccessToken` with a `jwksFetch` callback calling `auth.api.getJwks()` in process, plus the provider's `createResourceServerChallenge`. This reuses vendor verification/challenge code; it is not a handwritten signature or token stack.

Digital Shelf must run that call inside the existing invocation bridge. The auth instance is lazy, and every current API/handler call is wrapped by `withInvocation` so the request-owned Effect/DB context reaches Better Auth ([`Auth.ts:116-155`](https://github.com/NicePakProducts/effect-digital-shelf/blob/1eb7fa2af407c65c12a7af7325caa9dedb77d4e4/packages/core/src/Auth/Auth.ts#L116-L155), [`BetterAuthAdapter.ts:29-67`](https://github.com/NicePakProducts/effect-digital-shelf/blob/1eb7fa2af407c65c12a7af7325caa9dedb77d4e4/packages/core/src/Auth/BetterAuthAdapter.ts#L29-L67)). The once-built layer must not cache an invocation context or socket; only a stable JWKS cache key/key set is safe to retain.

## 4. Resource, audience, and subject binding

`mcp({ resource })` adds `${AUTH_BASE_URL}/mcp` to resources/default client resources ([`plugin.ts:170-187`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/mcp/src/plugin.ts#L170-L187)). JWT issuance stamps:

- `aud` from the resolved resource policy,
- `sub` as the Better Auth `user.id` for a user grant (client ID only for client credentials),
- `client_id` and `azp` as the OAuth client,
- `scope`, canonical issuer, `iat`, and `exp`.

Source: [`token.ts:253-289`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L253-L289).

Thus the protected adapter must require exact configured issuer `${AUTH_BASE_URL}/api/auth`, exact audience `${AUTH_BASE_URL}/mcp`, the one agreed MCP scope, and a non-empty string `sub`; it should then resolve that `sub` to the existing admitted Digital Shelf User server-side. It must never take a User ID from an MCP tool argument. `client_id`/`azp` should be retained for audit and revocation attribution.

## 5. Exact token lifecycle in 1.7.3

The direct settings for the agreed timeouts are:

```ts
accessTokenExpiresIn: 15 * 60,
refreshTokenExpiresIn: 30 * 24 * 60 * 60,
refreshTokenReuseInterval: 30, // mcp() default; see decision below
```

A refresh token is issued only when the client permits `refresh_token` **and** the authorization includes `offline_access` ([`token.ts:1142-1150`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L1142-L1150)). Therefore the approved scope set and Claude authorization request must include `offline_access` in addition to the application MCP scope.

### Rotation is sliding, not absolute

Every rotation calls `createUserTokens` with the old refresh record, computes a fresh `iat`, and creates the replacement with `expiresAt = new iat + refreshTokenExpiresIn` ([`token.ts:593-705`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L593-L705), [`token.ts:1930-1958`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L1930-L1958)). There is no original-family absolute-expiry option in `OAuthOptions`; the public option is a per-token TTL ([`types/index.ts:631-667`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/types/index.ts#L631-L667)). An actively refreshed connection can therefore continue indefinitely. “30 days” means 30 days since the latest successful rotation.

### Reuse/replay behavior

Rotation atomically marks the parent revoked and creates a child. With the MCP default 30-second reuse interval, the provider encrypts and stores the exact successful response; a retry with the same effective scopes, resources, and sender constraint gets that same response with adjusted `expires_in` ([`token.ts:651-705`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L651-L705), [`token.ts:990-1049`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L990-L1049)). A different replay inside the window fails `invalid_grant`. Reuse after the window invalidates all refresh rows for that client/User pair, then fails ([`token.ts:1898-1927`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L1898-L1927)).

The safeguards have explicit limits. The provider notes that a concurrent rotation loser fails closed but does not yet atomically invalidate the family, and family deletion itself races a rotation in another Worker ([`token.ts:520-567`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L520-L567), [`token.ts:651-665`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/token.ts#L651-L665)). The 30-second replay is retry tolerance, not proof of strict RFC 9700 family invalidation.

## 6. Browser logout is independent only for refresh; local JWT checks miss revocation

Pinned 1.7.3 deliberately preserves refresh tokens carrying `offline_access` when the browser session ends, while revoking non-offline refresh rows ([`logout.ts:105-174`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/logout.ts#L105-L174)). This matches the confirmed requirement that Claude remains connected after browser logout.

JWT access tokens are self-contained and are not stored. Better Auth's revocation endpoint explicitly reports that a valid JWT cannot be revoked server-side ([`revoke.ts:34-45,109-116`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/revoke.ts#L34-L45)). The same-Worker local verification path checks cryptography/claims only; it does not query consent, refresh family, client disabled state, or browser session. Consequently:

- browser logout leaves an already issued JWT usable until `exp` (at most 15 minutes under the agreed config);
- a correctly coordinated Connected-app revocation operation must stop refresh, but stock consent deletion does not provide that guarantee and concurrent token minting still needs a design/proof; an already issued JWT remains usable until `exp`;
- deleting consent alone does not even stop refresh.

This is the exact revocation latency for the recommended JWT/JWKS mode: **0–15 minutes**, not immediate. Resolving `sub` to a current User each MCP request catches a deleted User, but does not make grant revocation immediate.

## 7. Per-User consent APIs exist; grant revocation does not

The plugin exposes session-authenticated:

- `GET /oauth2/get-consents`, filtered by the current session's `user.id`;
- `GET /oauth2/get-consent?id=...`, ownership checked;
- `POST /oauth2/delete-consent`, ownership checked;
- `POST /oauth2/update-consent`, ownership checked.

Sources: [`oauthConsent/index.ts:11-89`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/oauthConsent/index.ts#L11-L89), [`oauthConsent/endpoints.ts:22-101`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/oauthConsent/endpoints.ts#L22-L101). Consent rows contain `clientId`, `userId`, resources, scopes, and timestamps ([`types/index.ts:1923-1942`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/types/index.ts#L1923-L1942)).

`deleteConsentEndpoint` deletes only `oauthConsent`; it never touches `oauthRefreshToken` or `oauthAccessToken` ([`oauthConsent/endpoints.ts:68-101`](https://github.com/better-auth/better-auth/blob/597d39cb4aaaac1ad729051fbdd22a63b8ba8d8d/packages/oauth-provider/src/oauthConsent/endpoints.ts#L68-L101)). The generic RFC 7009 endpoint cannot implement a dashboard “revoke this grant” operation because it expects possession of the plaintext refresh token, while Better Auth stores it hashed and the browser does not have Claude's token. DCR-created clients are also not owned by the consenting User, so the per-User client-delete endpoint is not the right abstraction.

# Recommendations requiring HITL approval

## A. Minimal provider configuration

Approve a configuration equivalent to:

```ts
mcp({
  loginPage: "/sign-in",
  consentPage: "/consent",
  resource: `${baseURL}/mcp`,
  allowDynamicClientRegistration: true,
  allowUnauthenticatedClientRegistration: true,
  grantTypes: ["authorization_code", "refresh_token"],
  scopes: [MCP_SCOPE, "offline_access"],
  clientRegistrationDefaultScopes: [MCP_SCOPE, "offline_access"],
  accessTokenExpiresIn: 15 * 60,
  refreshTokenExpiresIn: 30 * 24 * 60 * 60,
  refreshTokenReuseInterval: 30,
})
```

Choose a technical identifier for the agreed full-feature application scope in place of `MCP_SCOPE`; the permission model is settled, but no literal identifier was selected. Do not add `client_credentials` or a `jwt-bearer` handler merely to accept Claude metadata.

## B. Narrow DCR policy/normalization adapter

At only `POST /api/auth/oauth2/register`, validate the decoded body before forwarding it to the existing `auth.handler` inside `withInvocation`:

1. exact redirect list `["https://claude.ai/api/mcp/auth_callback"]`;
2. exact response list `["code"]`;
3. required grants include both `authorization_code` and `refresh_token`;
4. only the known surplus `urn:ietf:params:oauth:grant-type:jwt-bearer` may be removed;
5. reject every other unexpected grant, redirect, response type, resource, or scope;
6. allow `none` and do not conceptually forbid automatically provisioned confidential credentials solely because setup was URL-only; finalize the accepted auth-method set from the live Claude trace;
7. forward the normalized authorization-code+refresh request to Better Auth, which remains responsible for validation, credentials, persistence, PKCE, token exchange, and metadata response.

This is safer than generic union intersection. It makes the compatibility exception explicit and alerts on future Claude changes rather than silently broadening acceptance. Consent must label client branding/self-asserted metadata as unverified.

## C. Minimal Auth service adapter; no second issuer

Expose only these application-facing methods from the existing core `Auth` service, each resolving the lazy Better Auth instance and running the whole vendor call in `withInvocation`:

- `handle(request)` — existing discovery/OAuth routes, with the narrow DCR preprocessing above;
- `verifyMcpBearer({ request, issuer, audience, requiredScopes })` — vendor `verifyJwsAccessToken` + in-process `auth.api.getJwks()`, vendor challenge construction, strict claim decoding, then current-User resolution;
- `listConnectedApps({ headers })` — vendor `getOAuthConsents`, enriched with the corresponding public client display metadata and clearly marked self-asserted;
- `revokeConnectedApp({ headers, consentId })` — session ownership validation followed by one application-owned transactional delete of that User/client consent and all refresh-token-family rows for that User/client.

The last operation needs a real core repository/transaction in accordance with project boundaries because Better Auth exposes no public grant-revoke primitive. **Parent source-check caveat:** source explicitly documents family deletion racing token minting. A transaction containing only consent/family deletes is not a complete revocation design: the follow-on decision must establish coordination/fencing with concurrent refresh and authorization-code exchange so an in-flight mint cannot recreate a grant's usable tokens after revocation. Any linked opaque access-token rows also need the provider's required cleanup order. No such concurrent behavior was executed here. It must not accept arbitrary `userId`/`clientId` from the browser as authority. This narrow lifecycle operation does not mint, parse, sign, exchange, or issue tokens and therefore is not a second OAuth implementation.

Do not adopt a second issuer, Cloudflare OAuth Provider, custom signing code, remote JWKS self-fetch, or per-request capture in the once-built layer.

## D. Lifecycle policy choices

- Treat 30 days as **sliding from each successful rotation** unless HITL requires an absolute family maximum. Pinned 1.7.3 cannot express both through configuration.
- Retain the MCP default 30-second matching-response replay only if retry resilience is worth its bounded replay window and known concurrency limitations. Setting `refreshTokenReuseInterval: 0` is stricter but may make a lost refresh response force reconnection.
- Document explicit grant-revocation latency as at most 15 minutes for already issued JWTs. Revocation must delete refresh families immediately; the next refresh must fail. Do not promise immediate JWT rejection.
- Browser sign-out must continue preserving `offline_access` refresh tokens. Connected-app revocation is a distinct action.

# Required negative and executable tests

## Registration/discovery

- Metadata advertises DCR, only `authorization_code` + `refresh_token`, compatible auth methods, S256, canonical issuer/resource, and no `client_credentials`.
- URL-only registration succeeds for a fixture matching the observed Claude union after removing only known `jwt-bearer`.
- Reject missing authorization-code or refresh grant, empty mutual grants, every unknown surplus grant, wrong/multiple redirect, fragment, insecure redirect, wrong response type, excess resource/scope, invalid auth method, and `client_credentials`.
- Verify a confidential DCR fixture receives credentials automatically and a public `none` fixture does not; neither involves human credential entry.
- Registration/client names and icons are escaped and displayed as unverified.

## Bearer/resource/identity

- Valid JWT succeeds with exact configured issuer, `${baseURL}/mcp` audience, MCP scope, and existing User subject.
- Reject missing/malformed/expired token, bad signature, wrong issuer, wrong/multiple-without-target audience, missing scope, client-credentials subject, nonexistent User, and cookie-only authentication.
- Assert 401/403 challenges contain the canonical protected-resource metadata and required scope.
- Regression: two independent Worker/invocation contexts verify tokens with an in-process JWKS callback and never fetch their own hostname; concurrent real-Postgres calls retain the correct `withInvocation` DB context.

## Lifecycle and Connected apps

- Assert access `exp - iat = 900`; initial and every rotated refresh row expires 2,592,000 seconds after **that row's** creation, proving sliding behavior.
- Assert every successful refresh returns a new refresh token and revokes the parent.
- Within 30 seconds: exact retry returns the same response; changed scope/resource/sender constraint fails. After 30 seconds: old-token reuse fails and invalidates the User/client refresh family. Cover concurrent redemption and record the pinned provider's documented race limitation.
- Browser logout: existing JWT expires normally; `offline_access` refresh still succeeds; non-offline refresh does not survive.
- `getOAuthConsents` never returns another User's grants. Cross-User get/delete/revoke is denied.
- Connected-app revoke deletes only the selected current-User/client consent and refresh family; subsequent refresh fails. Race revocation against refresh and authorization-code exchange in both orderings over disposable PostgreSQL, proving no surviving/recreated refresh family. It must not delete another User's grant to the shared DCR client.
- Prove a pre-revocation JWT remains valid through local JWKS verification until `exp`, then fails; report the measured 0–15 minute window rather than asserting immediate revocation.
- Deleting consent through the raw provider endpoint alone must be a regression test showing refresh remains valid, so UI code cannot accidentally mistake consent deletion for revocation.

# Unexecuted/live evidence gaps

- **No Claude.ai DCR exchange was run.** The exact DCR body, discovery order, token endpoint authentication actually selected, PKCE exchange, `offline_access` request, and secret retention are not proved. Claude's live CIMD document and Better Auth issue #11081 are strong bounded evidence, not a substitute for the smoke.
- **No workerd/Cloudflare test was run.** Same-host self-fetch failure is supported by Better Auth #10888 and pinned source; the proposed in-process adapter still needs an isolate-level regression.
- **No lifecycle test was executed against Digital Shelf's Postgres adapter.** The source establishes intended behavior and known races, but the application's transaction/repository operation must be tested with the real adapter.
- **No revocation delay was measured live.** Source bounds JWT validity to the configured 15-minute TTL and proves local verification has no revocation lookup; release evidence should measure it.

The release smoke should enter only `${origin}/mcp` in Claude.ai, capture redacted discovery/DCR/token shapes, approve and deny consent, cross browser logout, force refresh/rotation, revoke from Connected apps, show the next refresh fails, and measure when the last JWT stops working. Until that succeeds, the project must not claim live Claude.ai compatibility.

# Newly exposed decision questions only

1. Does “30-day refresh” mean the provider's available **sliding 30 days after every rotation**, or is a hard 30-day lifetime from initial consent required? The latter needs additional family-origin state/policy or a provider change.
2. Should Digital Shelf retain `mcp()`'s 30-second exact-response refresh retry window, accepting its bounded replay/concurrency limitations, or set it to zero and accept more reconnects after lost responses?
3. For the temporary 1.7.3 DCR seam, approve the narrowly allowlisted Claude `jwt-bearer` normalization adapter, or defer compatibility until Better Auth adopts an upstream DCR policy change? Generic unknown-grant filtering is not recommended.
