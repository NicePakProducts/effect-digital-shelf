import * as Atom from "effect/unstable/reactivity/Atom"
import { createAuthClient } from "better-auth/client"
import { magicLinkClient } from "better-auth/client/plugins"
import * as Schema from "effect/Schema"

export type AuthClient = ReturnType<
  typeof createAuthClient<{
    plugins: [ReturnType<typeof magicLinkClient>]
  }>
>

export const createClient = (
  options: { readonly baseURL?: string } = {},
): AuthClient =>
  createAuthClient({
    ...options,
    plugins: [magicLinkClient()],
    fetchOptions: {
      onResponse: (context: { readonly response: Response }) => {
        if (
          !context.response.headers
            .get("content-type")
            ?.includes("application/json")
        )
          throw new AuthActionError()
      },
    },
  })

export class AuthActionError extends Schema.TaggedError<AuthActionError>()(
  "AuthActionError",
  {},
) {}

export function sessionAtom<A>(store: {
  readonly get: () => A
  readonly subscribe: (listener: (value: A) => void) => () => void
}) {
  return Atom.make((context) => {
    context.addFinalizer(store.subscribe((value) => context.setSelf(value)))

    return store.get()
  })
}
