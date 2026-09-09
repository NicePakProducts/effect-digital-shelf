export const parseDomains = (value: string): ReadonlyArray<string> =>
  value
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)

export const isAllowlisted = (
  email: string,
  domains: ReadonlyArray<string>,
): boolean => {
  const at = email.lastIndexOf("@")
  const domain = email.slice(at + 1).toLowerCase()
  return (
    at > 0 &&
    domain.length > 0 &&
    domains.some((allowed) => allowed.toLowerCase() === domain)
  )
}
