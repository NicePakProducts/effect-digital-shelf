import { expect, it } from "@effect/vitest"
import { isAllowlisted, parseDomains } from "@digital-shelf/core/Auth/Allowlist"

it("matches exact domains case-insensitively and rejects malformed addresses", () => {
  for (const email of ["someone@npbrands.com.au", "Someone@NPBrands.com.au"])
    expect(isAllowlisted(email, ["npbrands.com.au"])).toBe(true)

  for (const email of [
    "npbrands.com.au",
    "someone@",
    "@npbrands.com.au",
    "someone@npbrands.com.au.evil.com",
    "someone@sub.npbrands.com.au",
  ])
    expect(isAllowlisted(email, ["npbrands.com.au"])).toBe(false)
  expect(isAllowlisted("someone@npbrands.com.au", [])).toBe(false)
  expect(
    isAllowlisted("someone@other.com", ["npbrands.com.au", "OTHER.com"]),
  ).toBe(true)
  expect(parseDomains(" NPBrands.com.au, , OTHER.com ,")).toEqual([
    "npbrands.com.au",
    "other.com",
  ])
})
