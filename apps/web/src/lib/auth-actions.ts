import { createAuthClient } from "better-auth/client"
import { magicLinkClient } from "better-auth/client/plugins"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { callbacks } from "./auth-navigation"

export const createClient = (options: { readonly baseURL?: string } = {}) =>
  createAuthClient({
    ...options,
    plugins: [magicLinkClient()],
    fetchOptions: {
      onResponse: ({ response }) => {
        if (!response.headers.get("content-type")?.includes("application/json"))
          throw new AuthActionError()
      },
    },
  })

export class AuthActionError extends Schema.TaggedError<AuthActionError>()(
  "AuthActionError",
  {},
) {}

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
