import { createFileRoute } from "@tanstack/react-router"
import { useAtomValue } from "@effect/atom-react"
import { authActions, authSession } from "../lib/auth"
import { useAuthAction } from "../lib/use-auth-action"

export const Route = createFileRoute("/_authenticated/")({ component: Home })

function Home() {
  const session = useAtomValue(authSession)
  const action = useAuthAction()

  return (
    <div className="workspace-page">
      <title>Digital Shelf</title>
      <header>
        <strong>digital shelf.</strong>
        <span>{session.data?.user.email}</span>
        <button
          disabled={action.pending}
          onClick={() =>
            void action.run(authActions.signOut, () => {
              // Drop all in-memory private state after confirmed SDK synchronization.
              window.location.replace("/sign-in")
            })
          }
        >
          {action.pending ? "Signing out…" : "Sign out"}
        </button>
      </header>
      {action.failed && (
        <p role="alert">We couldn’t complete sign-out. Please try again.</p>
      )}
      <main>
        <h1>You’re in. Welcome to Digital Shelf.</h1>
        <p>One place for your catalog, Scrapes and Extractions.</p>
      </main>
    </div>
  )
}
