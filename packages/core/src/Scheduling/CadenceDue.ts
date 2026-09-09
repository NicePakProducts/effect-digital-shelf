import type { Cadence } from "@digital-shelf/domain/Catalog/Cadence"
import type { ScrapeStatus } from "@digital-shelf/domain/Scraping/Vocabulary"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Option from "effect/Option"

/**
 * Cadence-due (CONTEXT.md): a Parent is due when its most recent Scrape,
 * whatever its outcome, is older than its cadence, or when it has never
 * been scraped. After a failure the wait is the shorter of the cadence and
 * the Failure retry interval. Fixed intervals, not calendar maths: a day
 * early on a 31-day month is harmless and the arithmetic stays
 * deterministic. The SQL selection in ParentsRepo mirrors this function and
 * the PGlite tests hold the two together.
 */
export const cadenceInterval: Record<Cadence, Duration.Duration> = {
  daily: Duration.days(1),
  weekly: Duration.days(7),
  fortnightly: Duration.days(14),
  monthly: Duration.days(30),
}

export interface LatestScrape {
  readonly createdAt: DateTime.Utc
  readonly status: ScrapeStatus
}

/** How long after `latest` the Parent waits before it is due again. */
export const waitAfter = (
  latest: LatestScrape,
  cadence: Cadence,
  failureRetryInterval: Duration.Duration,
): Duration.Duration =>
  latest.status === "failed"
    ? Duration.min(cadenceInterval[cadence], failureRetryInterval)
    : cadenceInterval[cadence]

export const isCadenceDue = (
  latest: Option.Option<LatestScrape>,
  cadence: Cadence,
  failureRetryInterval: Duration.Duration,
  now: DateTime.Utc,
): boolean =>
  Option.match(latest, {
    onNone: () => true,
    onSome: (last) =>
      DateTime.isLessThanOrEqualTo(
        DateTime.addDuration(
          last.createdAt,
          waitAfter(last, cadence, failureRetryInterval),
        ),
        now,
      ),
  })
