import { createFileRoute, notFound } from "@tanstack/react-router"
import { AuthPrototype } from "../prototypes/auth/AuthPrototype"
import type { PrototypeVariant } from "../prototypes/PrototypeSwitcher"

interface AuthPrototypeSearch {
  readonly variant: PrototypeVariant
}

export const Route = createFileRoute("/prototype/auth")({
  beforeLoad: () => {
    if (import.meta.env.PROD) throw notFound()
  },
  validateSearch: (search): AuthPrototypeSearch => ({
    variant:
      search.variant === "B" || search.variant === "C" ? search.variant : "A",
  }),
  component: AuthPrototypeRoute,
})

function AuthPrototypeRoute() {
  const search = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <AuthPrototype
      variant={search.variant}
      onVariantChange={(variant) =>
        void navigate({ search: { variant }, replace: true })
      }
    />
  )
}
