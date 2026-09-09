import * as Schema from "effect/Schema"

/** How often a Parent is scraped. Stored as the `cadence` Postgres enum. */
export const Cadences = ["daily", "weekly", "fortnightly", "monthly"] as const
export const Cadence = Schema.Literals(Cadences)
export type Cadence = typeof Cadence.Type
export const defaultCadence: Cadence = "monthly"
