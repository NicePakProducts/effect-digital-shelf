# Auth experience — THROWAWAY prototype

**Question:** which entry experience feels right for Digital Shelf before we wire the real magic-link backend?

**Verdict:** pending hands-on review. Do not promote this code to production.

## Run

From the repository root, with dependencies installed:

```sh
bun run --filter @digital-shelf/web prototype:auth
```

Opens `http://localhost:3000/prototype/auth`. No Worker, environment file, database or email service is needed. The route is unavailable in production builds.

- `?variant=A` — Focused: centred form, quiet workspace identity.
- `?variant=B` — Split-screen: product context beside sign-in.
- `?variant=C` — App-first: enter from the surrounding workspace shell.

Use the floating arrows or keyboard left/right to switch. Arrow keys are left alone in editable fields. Switching preserves the current flow and email; refreshing resets the simulation, but keeps the layout from the URL.

## Try it

1. Enter any sample `@npbrands.com.au` email (or use **Prototype controls → Use sample email**).
2. Submit **Send sign-in link**. No actual email is sent.
3. Expand **Prototype controls** and open the simulated magic link.
4. Inspect the minimal signed-in shell, then **Sign out**.
5. Repeat with **Open expired link** or **Open used link**; return to sign-in and request a fresh link.
6. Toggle **Fail next email request** before submitting or resending. It fails once; the next request succeeds.
7. Try another email domain: the public confirmation stays generic, but the controls cannot open a link. The fixture allowlist is not production configuration.
8. **Reset demo** starts over without changing the layout. **Live state** in the control panel shows every relevant in-memory field and the simulated session.

## Browser verification

Exercised with `bunx agent-browser` in an isolated Chromium session:

- All three layouts at 1440 × 1000 and 390 × 844, without horizontal overflow.
- Email validation, sample email, send/resend failure and recovery, expired/used-link recovery, sign-in, sign-out, suppressed email domain, and reset.
- Layout wraparound, URL selection, retained form state between layouts, arrow keys inside inputs, and refresh resetting the simulated session.
- No requests to `/api/`, no auth cookies or persisted auth state. The existing router still stores its scroll-restoration metadata.
- Production preview returns **Page not found** for this route.

`vp check` and the web build pass. `vp test --run` exits successfully with no test files; no automated test suite was added to this throwaway prototype. Browser checks exercise the simulation, not the real auth backend.

## Boundaries

- An Effect atom owns the simulation. No cookies, storage, auth client or API requests.
- The controls inject outcomes; there are no real tokens, expiration timers or email delivery.
- All catalog/navigation previews are placeholders, not functioning catalog screens.
- Production follow-up: real magic-link delivery/verification, session loading and refresh, a server-backed auth gate, protected-URL return, sign-out, and proper tests. The simulated shell is not an authentication boundary.
- The three layouts intentionally share the form/state flow and the signed-in destination, not the sign-in layout.

Keep the complete prototype on `prototype/auth-experience`, out of main. Once a direction wins, record the verdict and a branch pointer on the implementation issue; implement the chosen experience properly rather than promoting this simulation.
