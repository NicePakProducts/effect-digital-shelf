# Scrape lifecycle safety comes from the database, not from locks

Scrapes are dispatched concurrently by API requests, bulk triggers and an every-minute Cron whose ticks may overlap, and each Scrape is carried out by a Cloudflare Workflow whose steps can be replayed. We make the two lifecycle invariants facts of the schema and of every write, so no writer has to coordinate with another:

- **In-flight refusal is two partial unique indexes** on `scrapes`: one on `listing_id` and one on `page_id`, each `WHERE status IN ('pending', 'running')`. An insert either succeeds or raises a unique violation, which the repository classifies into `ParentInFlight`. Cron and bulk inserts use a bare `ON CONFLICT DO NOTHING` (Drizzle's `onConflictDoNothing` can target only one partial index, and the primary key on a fresh UUID never conflicts); the manual trigger inserts plainly and reads the index name off the violation.
- **Every transition is a conditional update**: `UPDATE ... WHERE id = ? AND status = <expected> RETURNING`. Zero rows means the writer re-reads the row: if it is already in the target state the transition was applied by an earlier run of the same step (Workflows checkpoint after the step returns, so a step can commit and then run again); anything else means the transition was lost to another writer, and the Execution stops. Terminal states are final, so a late outcome after the stuck sweep is discarded rather than resurrecting the row.

## Considered options

- **`SELECT ... FOR UPDATE` on the Parent row inside the dispatch transaction.** Rejected: it serialises every trigger on the Parent and keeps the rule in code, where the migration script and any future writer can miss it.
- **An advisory lock around the Cron tick** to make cadence selection strictly once-per-cadence. Rejected: Cloudflare does not document whether scheduled ticks overlap, so the lock would guard an unknown; the partial indexes already bound the damage of an overlap to one extra Scrape, which we accept.
- **Treating zero updated rows as always lost.** Rejected: a replayed `claim` would abandon a healthy row to the stuck sweep, and a replayed `finish` would delete the HTML it had just stored.
- **Making `failed` non-terminal so a late success can win.** Rejected: every reader (combined status, latest data) would have to cope with a row that comes back to life.

## Consequences

- Cadence-due is measured from the Parent's most recent Scrape of any status (a lateral subquery, no new column), so the retention window must exceed the longest cadence or the sweep removes the anchor.
- Reconcile fails a `pending` row only on a confirmed terminal Execution status; `unknown`, not-found and lookup failures leave the row for the next tick.
- The Execution's identity is the Scrape id and is single-use, which is what makes "already in the target state" attributable to an earlier run of the same step rather than to a stranger.
