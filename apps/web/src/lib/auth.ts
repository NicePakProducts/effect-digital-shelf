import { createClient, sessionAtom } from "@app/client/auth"
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Browser composition of a foreign SDK adapter, not an Effect service constructor.
import { makeAuthActions } from "./auth-actions"

export const authClient = createClient()

export const authSession = sessionAtom(authClient.useSession)

export const authActions = makeAuthActions(authClient)

export type AuthSession = ReturnType<typeof authClient.useSession.get>

export const auth = {
  ready: () =>
    new Promise<AuthSession>((resolve) => {
      const current = authClient.useSession.get()

      if (!current.isPending) return resolve(current)

      const unsubscribe = authClient.useSession.listen((session) => {
        if (session.isPending) return
        unsubscribe()
        resolve(session)
      })
    }),
}

export interface AuthContext {
  readonly auth: typeof auth
}
