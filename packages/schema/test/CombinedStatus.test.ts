import { describe, expect, it } from "@effect/vitest"
import {
  combinedStatus,
  LifecycleStatuses,
  type ScrapeStatus,
  type ExtractionStatus,
} from "@app/schema/scraping-vocabulary"
import { CascadeImpact, emptyImpact } from "@app/schema/cascade"
import { Option, Schema } from "effect"

describe("Combined status", () => {
  it("reads none without a Scrape, even if an Extraction is supplied", () => {
    for (const status of LifecycleStatuses)
      expect(combinedStatus(Option.none(), Option.some(status))).toBe("none")
    expect(combinedStatus(Option.none(), Option.none())).toBe("none")
  })
  it("keeps the Scrape status when no Extraction exists", () => {
    for (const status of LifecycleStatuses)
      expect(combinedStatus(Option.some(status), Option.none())).toBe(status)
  })
  it("uses dominant-failure precedence for every status pair", () => {
    const expected: Record<
      ScrapeStatus,
      Record<ExtractionStatus, ScrapeStatus>
    > = {
      failed: {
        failed: "failed",
        pending: "failed",
        running: "failed",
        success: "failed",
      },
      pending: {
        failed: "failed",
        pending: "pending",
        running: "pending",
        success: "pending",
      },
      running: {
        failed: "failed",
        pending: "pending",
        running: "running",
        success: "running",
      },
      success: {
        failed: "failed",
        pending: "pending",
        running: "running",
        success: "success",
      },
    }

    for (const scrape of LifecycleStatuses)
      for (const extraction of LifecycleStatuses)
        expect(
          combinedStatus(Option.some(scrape), Option.some(extraction)),
        ).toBe(expected[scrape][extraction])
  })
  it("accepts zero impact and rejects negative or fractional counts", () => {
    expect(Schema.decodeUnknownSync(CascadeImpact)(emptyImpact)).toEqual(
      emptyImpact,
    )

    for (const products of [-1, 0.5])
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(CascadeImpact)({
            ...emptyImpact,
            products,
          }),
        ),
      ).toBe(true)
  })
})
