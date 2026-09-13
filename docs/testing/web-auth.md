# Web authentication verification

The real SPA uses Better Auth's vanilla session store, subscribed through an
Effect atom. Guards and UI read that same store; no credentials or user snapshot
are written to application storage. The SDK owns focus/online/cross-tab refresh.
Sign-out waits for SDK session synchronization, then replaces the document to
drop in-memory app state. The Worker remains the authentication gate for API data.

## Scratch browser server

Do not use the ordinary Alchemy dev server for automated auth smokes: its
Hyperdrive origin uses the stage database. These commands instead start a
loopback-only fixture with **in-memory PGlite and captured emails**:

```sh
# Terminal 1, repository root
bun packages/core/test/Auth/browser-server.ts

# Terminal 2, repository root; keep port 3002 free
WEB_API_PROXY_TARGET=http://127.0.0.1:1437 \
  bun run --filter @digital-shelf/web dev --port 3002

# Terminal 3
bunx agent-browser open http://localhost:3002
bunx agent-browser snapshot -i
```

The scratch Auth base URL is deliberately `http://localhost:3002`, matching the
browser origin. Origin and CSRF validation remain enabled, including under tests.
No stage configuration or real mailbox is involved. Restarting the fixture drops
its database and captured email. Test controls exist only in this standalone
fixture; no Worker or browser application imports it.

After submitting an allowlisted test address, open
`http://localhost:3002/api/__test/open-link` in the same browser. This follows the
latest captured email's original verification URL without copying a token into
shell history. Opening it again exercises single-use recovery.

Local fixture controls:

- `/api/__test/email-count`: number of captured emails, no message/token contents.
- `/api/__test/outage`: toggle HTTP 503 for session lookup.
- `/api/__test/sign-out-failure`: toggle HTTP 503 for sign-out.
- `/api/__test/slow`: toggle a two-second delay for auth requests.

Use `curl` against localhost:3002 for toggles, not the deployed app. Stop both
fixture and Vite processes when finished. Never store browser cookies or email
verification URLs in committed artifacts.

## Coverage

Automated tests cover:

- Return-path policy, canonicalization and idempotent search validation.
- SDK → Effect session publication, request failures, transport rejection and a
  misconfigured proxy returning HTML instead of JSON.
- Real Auth HTTP cookie issuance/restoration/logout, consumed and expired links,
  suppressed domains, origin rejection and encoded callbacks through verification.
- Real API handlers and authentication middleware: anonymous denial, authenticated
  access and denial after browser cookie removal.

`agent-browser` was also used against the scratch fixture for request/resend,
initial loading, outage/retry, malformed return URLs, disabled pending controls,
two immediate form submissions producing one email, refresh, failed logout,
cross-tab logout, back-navigation, reused-link recovery, and desktop/mobile layout
(1440×1000 and 390×844). A return destination of
`/?q=Nice%20Pak%26Co#list` survived the complete browser/email/verification flow.

These checks do not prove live email delivery or immediate global revocation;
Better Auth's existing five-minute signed cookie cache policy is unchanged.
Subscription cleanup is wired through the atom finalizer; cross-tab behavior was
exercised in the browser, not simulated by replacing the SDK store.

## Callback encoding constraint

Better Auth 1.7.3 performs an extra `decodeURIComponent` during magic-link
verification. The client therefore escapes existing percent signs once when
building callbacks, leaving the leading slash intact for origin validation.
Encoding the whole URL fails origin validation; passing raw encoded query values
can change their meaning on verification. Both client expectations and real HTTP
round trips protect this behavior. Recheck it when upgrading Better Auth.
