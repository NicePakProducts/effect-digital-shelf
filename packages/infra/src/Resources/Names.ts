export type Stage = "dev" | "prod"

/** Reject Alchemy's user-derived default before declaring any resources. */
export const stageOf = (value: string): Stage => {
  if (value === "dev" || value === "prod") return value
  throw new Error(
    `Unsupported Digital Shelf stage "${value}"; use --stage dev or --stage prod`,
  )
}

export const resourceName = (stage: Stage, what: string) =>
  `digital-shelf-${what}-${stage}`
