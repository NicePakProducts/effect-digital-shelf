export type Stage = "dev" | "prod"

/**
 * The stages `alchemy deploy` may target. `alchemy dev` runs on a private
 * per-user stage (Alchemy's `dev_<user>` default) whose state never overlaps
 * these, so local emulation cannot replace the deployed resources.
 */
export const isDeployedStage = (value: string): value is Stage =>
  value === "dev" || value === "prod"

/** Configuration profile of a stage name: only `prod` is prod; every private local stage runs with dev settings. */
export const stageOf = (value: string): Stage =>
  value === "prod" ? "prod" : "dev"

export const resourceName = (stage: Stage, what: string) =>
  `digital-shelf-${what}-${stage}`
