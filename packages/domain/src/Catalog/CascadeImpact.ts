import * as Schema from "effect/Schema"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Cascade impact counts descendants removed with a row. Extractions follow their
 * Scrape and are not counted; kinds absent beneath the root stay zero. */
export const CascadeImpact = Schema.Struct({
  products: Count,
  variants: Count,
  listings: Count,
  pages: Count,
  scrapes: Count,
})

export type CascadeImpact = typeof CascadeImpact.Type

export const emptyImpact: CascadeImpact = {
  products: 0,
  variants: 0,
  listings: 0,
  pages: 0,
  scrapes: 0,
}
