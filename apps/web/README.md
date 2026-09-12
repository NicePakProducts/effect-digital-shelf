# Digital Shelf Web

Minimal React app with TanStack Router file-based routing and Tailwind CSS.

From the repository root:

```sh
bun install
bun run --filter @digital-shelf/web dev
```

The development server runs on port 3000. Use `bun run dev` from the repository
root to start both the web app and API server.

The home page subscribes to a typed API atom for the public `GET /api/v1/ping`
endpoint. It shows loading, errors, or `pong` with the server's timestamp.
Click **Send another request** to refresh the atom and see a new timestamp;
the browser's Network tab shows each request through the `/api` proxy.
No login is needed for this connection check.

```sh
bun run --filter @digital-shelf/web check
bun run --filter @digital-shelf/web test
bun run --filter @digital-shelf/web build
```

Linting uses Oxlint and formatting uses Oxfmt through Vite Plus, with the
shared workspace rules. From `apps/web`:

```sh
bun run lint
bun run lint:fix
bun run fmt
bun run fmt:check
```

`check` runs formatting, lint and type checks together.

Add routes under `src/routes/`. Vite generates `src/routeTree.gen.ts`; do not edit it manually.

## Atom state

`src/main.tsx` wraps the router in `RegistryProvider` from `@effect/atom-react`,
sharing one app-scoped registry across routes and disposing it on unmount.
Use hooks from `@effect/atom-react` and atom constructors from
`effect/unstable/reactivity/Atom`. Define shared atoms at module scope so their
identity stays stable across renders.

The matching v4 reference is `.repos/effect/packages/atom/react`.

## API client

`src/lib/api-client.ts` connects `AtomHttpApi` to the shared `RootApi` contract,
without importing server handlers. It owns the Effect runtime for API atoms;
no separate `Atom.runtime` is needed.

Create a query at module scope, then read it in a component:

```tsx
import { useAtomValue } from "@effect/atom-react"
import { ApiClient } from "./lib/api-client"

const brandsAtom = ApiClient.query("brands", "list", {})

// Inside a component: returns an AsyncResult with loading/success/failure state.
const brands = useAtomValue(brandsAtom)
```

Requests use same-origin `/api/v1` URLs and the browser's session cookies.
For local development, copy `.env.example` to `.env.local` and set
`WEB_API_PROXY_TARGET` to the local Worker URL. Vite proxies `/api`, including
Better Auth routes. Run the server separately; it uses real dev data as described
in `docs/agents/deploy.md` at the repository root.

Production hosting must route `/api` to the server on the same origin.
There is no login UI yet: protected queries return Unauthorized without a valid
Better Auth session. No requests run until a component subscribes to a query.
