import { expect, it } from "@effect/vitest"
import {
  callbacks,
  safeReturnPath,
  signInSearch,
} from "../src/lib/auth-navigation"

it("retains invalid-link recovery through router search revalidation", () => {
  const search = signInSearch({ error: "INVALID_TOKEN", redirect: "/" })
  expect(search.error).toBe("invalid")
  expect(signInSearch({ ...search }).error).toBe("invalid")
})

it("canonicalizes return paths before constructing callbacks", () => {
  expect(safeReturnPath("/brands/../?q=\ud800")).toBe("/?q=%EF%BF%BD")
  expect(callbacks("/brands/../?q=\ud800").callbackURL).toBe(
    "/?q=%25EF%25BF%25BD",
  )
})

it("preserves encoded separators in query values, not in the destination path", () => {
  expect(
    safeReturnPath("/?source=https%3A%2F%2Fretailer.test%2Fitem#details"),
  ).toBe("/?source=https%3A%2F%2Fretailer.test%2Fitem#details")
})

it("keeps internal query and fragment intent but rejects unsafe return destinations", () => {
  expect(safeReturnPath("/brands?q=Nice%20Pak#list")).toBe(
    "/brands?q=Nice%20Pak#list",
  )

  for (const path of [
    "https://evil.test",
    "//evil.test",
    "/brands/..//evil.test",
    "/\\evil.test",
    "/%2f%2fevil.test",
    "/%252f%252fevil.test",
    "/sign-in",
    "/api/auth/get-session",
    "/prototype/auth",
    "/a/../sign-in",
    "/%73ign-in",
    "/x\n",
    42,
  ]) {
    expect(safeReturnPath(path)).toBe("/")
  }

  expect(callbacks("/brands?q=Nice%20Pak#list")).toEqual({
    callbackURL: "/brands?q=Nice%2520Pak#list",
    newUserCallbackURL: "/brands?q=Nice%2520Pak#list",
    errorCallbackURL:
      "/sign-in?redirect=%252Fbrands%253Fq%253DNice%252520Pak%2523list",
  })
})
