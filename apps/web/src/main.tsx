import { RegistryProvider, useAtomValue } from "@effect/atom-react"
import { StrictMode, useEffect, useRef } from "react"
import { auth, authSession } from "./lib/auth"
import { createRoot } from "react-dom/client"
import { RouterProvider, createRouter } from "@tanstack/react-router"
import { routeTree } from "./routeTree.gen"
import "./styles.css"

const router = createRouter({
  routeTree,
  context: { auth },
  defaultPreload: "intent",
  defaultPendingMs: 0,
  defaultPendingMinMs: 0,
  scrollRestoration: true,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

function AuthRouter() {
  const session = useAtomValue(authSession)
  const identity = session.data?.user.id ?? null
  const previous = useRef(identity)
  useEffect(() => {
    if (previous.current === identity) return
    previous.current = identity
    // Guards read the SDK store, which is already updated before this effect.
    void router.invalidate()
  }, [identity])

  return <RouterProvider router={router} />
}

const rootElement = document.getElementById("app")!

createRoot(rootElement).render(
  <StrictMode>
    <RegistryProvider>
      <AuthRouter />
    </RegistryProvider>
  </StrictMode>,
)
