import { AuthActionError, createClient } from "@app/client/auth"
import * as Effect from "effect/Effect"
import { callbacks } from "./auth-navigation"

export function makeAuthActions(client: ReturnType<typeof createClient>) {
  return {
    requestLink: (input: {
      readonly email: string
      readonly redirect: string
    }) =>
      request(() =>
        client.signIn.magicLink({
          email: input.email.trim(),
          ...callbacks(input.redirect),
        }),
      ),
    signOut: request(() => client.signOut()).pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () => client.useSession.get().refetch(),
          catch: () => new AuthActionError(),
        }),
      ),
      Effect.flatMap(() => {
        const session = client.useSession.get()

        return session.error || session.data
          ? Effect.fail(new AuthActionError())
          : Effect.void
      }),
    ),
  }
}

function request(run: () => Promise<{ readonly error: unknown }>) {
  return Effect.tryPromise({
    try: run,
    catch: () => new AuthActionError(),
  }).pipe(
    Effect.flatMap((result) =>
      result.error ? Effect.fail(new AuthActionError()) : Effect.void,
    ),
  )
}
