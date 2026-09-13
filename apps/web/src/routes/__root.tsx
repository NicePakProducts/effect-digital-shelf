import {
  Link,
  Outlet,
  createRootRouteWithContext,
} from "@tanstack/react-router"
import type { AuthContext } from "../lib/auth"

export const Route = createRootRouteWithContext<AuthContext>()({
  component: Outlet,
  notFoundComponent: NotFound,
})

function NotFound() {
  return (
    <main className="p-6">
      <h1>Page not found</h1>
      <Link to="/">Return home</Link>
    </main>
  )
}
