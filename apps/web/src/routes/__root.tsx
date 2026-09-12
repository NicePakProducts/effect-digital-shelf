import { Link, Outlet, createRootRoute } from "@tanstack/react-router"

export const Route = createRootRoute({
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
