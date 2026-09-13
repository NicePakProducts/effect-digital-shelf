import { useAtomValue } from "@effect/atom-react"
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { authSession } from "../lib/auth"
import { AuthActionError } from "../lib/auth-actions"
import { safeReturnPath } from "../lib/auth-navigation"
import { SessionError, SessionLoading } from "../lib/AuthView"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context, location }) => {
    const session = await context.auth.ready()

    if (session.error) throw new AuthActionError()

    if (!session.data)
      throw redirect({
        to: "/sign-in",
        search: { redirect: safeReturnPath(location.href) },
        replace: true,
      })

    return { user: session.data.user }
  },
  pendingComponent: SessionLoading,
  errorComponent: SessionError,
  component: SessionGate,
})

function SessionGate() {
  const session = useAtomValue(authSession)

  if (session.error) return <SessionError />

  if (session.isPending || !session.data) return <SessionLoading />

  return <Outlet />
}
