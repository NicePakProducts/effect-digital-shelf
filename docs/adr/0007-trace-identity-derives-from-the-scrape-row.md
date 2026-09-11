# Trace identity derives from the Scrape row

Every span the system emits reaches Axiom over OTLP from Effect's own tracer, and one Scrape must read as one trace: its dispatch attempts, every Workflow step of its Execution, the sweeps and reconciles that touched it, and every Extraction ever run on it, initial or re-extract. Those spans are created by different invocations hours apart (a cron tick, an API request, a Workflow step, a later tick that redispatches a `pending` row), and none of them can reach the others' span context through memory. So the trace's identity is a function of the row:

- **The trace id is the Scrape id** with its dashes removed. A UUID is 128 bits, exactly an OTel trace id, and its variant bits keep the value non-zero. An agent goes from a row to its trace by stripping dashes, and a redispatch a day later lands in the same trace with no lookup.
- **The root span is emitted once, at creation.** The transaction that inserts the Scrape emits `Scrape.created`, closed immediately, and writes its span id to `scrapes.root_span_id`. Effect's `Tracer` interface mints span ids itself, so a root with a chosen id would need a custom tracer, and a trace whose root is never emitted is excluded from Axiom's documented root queries (`isnull(parent_span_id)`). One emitted root per Scrape means "count roots" counts Scrapes.
- **Everything else parents onto that root** as an external span built from the derived trace id and the stored span id: each `Scrape.dispatch` attempt (linked to the tick or request that made it), the Workflow steps (which receive the context as a `traceparent` string in the instance params), reconcile and the stuck sweep, and every Extraction's spans, tagged with `shelf.extraction.id` and `shelf.attempt`. Extractions need no column of their own.
- **Transitions say whether the database agreed.** Every transition span records `shelf.transition` as `applied`, `already_applied` or `rejected`, so a replayed step reads as a second sibling of the same name and counting `applied` never double-counts.
- **Telemetry is best effort.** A failed export drops that invocation's buffer, the scope close that flushes it is bounded, and no caller ever waits on Axiom. The database is the record of what happened; the trace is the record of how.

## Considered options

- **Continue the dispatcher's trace into the Workflow.** Rejected: a tick that starts fifty Scrapes would nest all fifty under one trace, and a redispatch from a later tick would start a second trace for the same Scrape.
- **A `traceparent` column written at creation.** Rejected: it stores a second identity that the row id already provides, and still needs the span id. Storing only the span id keeps the trace id derivable and the column narrow.
- **A never-emitted anchor span with a derived span id.** Rejected: Effect's tracer cannot emit a span with a chosen id, and viewers' handling of a trace with no root is unverified, while Axiom's own root aggregates exclude such traces.
- **A root emitted at `finish` with the dispatch time as its start.** Rejected: the public span options carry no `startTime`, and a crash before `finish` leaves the trace with no root at all.
- **One trace per Execution, Extractions with their own roots.** Rejected: the identity rule would then need a second column on `extractions`, and the requested reading of a Scrape is its fetch plus every extraction of it.

## Consequences

- Scrape creation is the one place that mints a root, so `Scrapes` (core) owns it, inside the same transaction as the insert; the Extraction lifecycle inherits the Scrape's context and adds no telemetry column.
- `Scrape.created` records the insertion result in `shelf.dispatch.outcome` (`created` or `in-flight-skip`); `Scrape.dispatch` and `Extraction.dispatch` record whether an Execution started in the boolean `shelf.dispatch.started`, with `shelf.execution.kind` identifying `scrape` or `extraction`.
- The `Executions` port carries the trace context into a Workflow instance's params as a W3C `traceparent` string, decoded with `HttpTraceContext.w3c` at each step.
- Retention removes the Scrape row, so a trace older than the retention window has no row to derive from; the trace itself stays queryable in Axiom by the id in the URL or the trace search.
- The AI Gateway joins the same trace through `cf-aig-otel-trace-id` and `cf-aig-otel-parent-span-id`, so its span, with `gen_ai.usage.cost`, sits under the Extraction's LLM span; cost is never computed in this codebase.
