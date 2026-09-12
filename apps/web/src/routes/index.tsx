import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { createFileRoute } from "@tanstack/react-router"
import * as Cause from "effect/Cause"
import * as DateTime from "effect/DateTime"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { ApiClient } from "../lib/api-client"

const pingAtom = ApiClient.query("ping", "get", {})

export const Route = createFileRoute("/")({
  component: Home,
})

function Home() {
  const ping = useAtomValue(pingAtom)
  const refresh = useAtomRefresh(pingAtom)

  return (
    <main className="p-6">
      <h1 className="text-2xl font-semibold">Digital Shelf</h1>
      <section className="mt-6 space-y-3">
        <h2 className="text-lg font-medium">API connection test</h2>
        <p>GET /api/v1/ping · No login required</p>
        <div aria-live="polite">
          {AsyncResult.match(ping, {
            onInitial: () => <p>Loading…</p>,
            onFailure: (result) => (
              <div>
                <p>
                  Request failed. Check that the API server and proxy are
                  running.
                </p>
                <pre className="whitespace-pre-wrap text-sm">
                  {Cause.pretty(result.cause)}
                </pre>
              </div>
            ),
            onSuccess: (result) => (
              <div className="space-y-1">
                <p>Connected. API replied: {result.value.message}</p>
                <p className="text-sm">
                  Server time: {DateTime.formatIso(result.value.timestamp)}
                </p>
              </div>
            ),
          })}
        </div>
        <button
          type="button"
          className="rounded border px-3 py-1 disabled:opacity-50"
          onClick={refresh}
          disabled={ping.waiting}
        >
          {ping.waiting ? "Loading…" : "Send another request"}
        </button>
      </section>
    </main>
  )
}
