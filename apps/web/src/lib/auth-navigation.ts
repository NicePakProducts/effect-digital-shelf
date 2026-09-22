import * as Option from "effect/Option"
import * as Schema from "effect/Schema"

const decodeString = Schema.decodeUnknownOption(Schema.String)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the untrusted URL parsing boundary.
export function safeReturnPath(input: unknown): string {
  const value = Option.getOrElse(decodeString(input), () => "/")

  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    // oxlint-disable-next-line no-control-regex -- Control characters must never reach a navigation destination.
    /[\\\u0000-\u0020\u007f]|%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    return "/"
  const url = new URL(value, "https://shelf.invalid")
  const path = url.pathname

  if (
    path.startsWith("//") ||
    path.includes("%") ||
    /^\/(?:sign-in|api|prototype|health)(?:\/|$)/i.test(path)
  )
    return "/"

  return `${path}${url.search}${url.hash}`
}

export function callbacks(input: string) {
  const path = safeReturnPath(input)

  return {
    // Better Auth 1.7.3 performs an extra decodeURIComponent on verification.
    callbackURL: path.replaceAll("%", "%25"),
    newUserCallbackURL: path.replaceAll("%", "%25"),
    errorCallbackURL:
      `/sign-in?redirect=${encodeURIComponent(path)}`.replaceAll("%", "%25"),
  }
}

interface SignInSearch {
  readonly redirect: string
  readonly error?: "invalid" | "unknown" | undefined
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- TanStack Router supplies untrusted search parameters at this boundary.
export function signInSearch(input: Record<string, unknown>): SignInSearch {
  return {
    redirect: safeReturnPath(input.redirect),
    error:
      input.error === "INVALID_TOKEN" || input.error === "invalid"
        ? "invalid"
        : input.error
          ? "unknown"
          : undefined,
  }
}
