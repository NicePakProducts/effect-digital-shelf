# Digital Shelf

A scrape management system. Every entity exists so the user can configure _what_ gets scraped, _how often_, and what clean data comes out of it. Old terms from the earliest generation of the app (audit, shelf, DCC score, roll-up) do not apply here.

## Language

### Catalog

**Brand**:
A top-level commercial identity (e.g. _Gaia_). Sub-brands are separate Brands; the system has no sub-brand concept.
_Avoid_: Company, manufacturer, client

**Product**:
A sellable item under exactly one Brand.
_Avoid_: Item, SKU

**Variant**:
A size, shade, or pack count of one Product, identified by a freeform name unique within that Product. Variants are scoped to one Product and never appear as options on another.
_Avoid_: Option, SKU, child product

**Retailer**:
A destination domain we scrape (e.g. _chemistwarehouse.com.au_), global and shared across all Brands. The domain is stored in canonical form: lower-case host, no scheme, path, port or leading `www.`, whatever the user pasted. Carries the scrape defaults and the two Extraction prompts (one per parent kind); has no capability flags.
_Avoid_: Store, site, merchant, vendor

**Listing**:
A Product's page on a Retailer. Belongs to exactly one Product and one Retailer, and covers zero or more Variants of that Product.
_Avoid_: Product page, PDP, SKU page

**Page**:
A Brand's storefront or brand page on a Retailer, added by the user because they want it scraped, regardless of whether the Retailer has a real brand-page concept. Belongs to exactly one Brand and one Retailer.
_Avoid_: BrandPage, brand store, storefront

**Parent**:
The Listing or Page a Scrape belongs to. Every Scrape has exactly one Parent; the scrape runner is identical for both kinds, only the Parent context differs.
_Avoid_: Target, source, owner

**Parent kind**:
Whether a Parent is a Listing or a Page. Selects which of the Retailer's two Extraction prompts applies.
_Avoid_: Type, entity type

**Variant coverage**:
The set of Variants a Listing covers, chosen by the user when creating or editing the Listing. Never derived from scrape data.
_Avoid_: Variant mapping, detected variants

**URL**:
The current pointer on a Listing or Page. Changing it does not create a new row and rewrites no history: every Scrape keeps the URL it actually fetched, and the next Scrape uses the new one. URLs are not unique, and the user owns correctness.
_Avoid_: Link, href, location

### Scraping

**Scrape**:
One attempt to fetch a Parent's URL and store the result. A failed Scrape is followed by a new Scrape, never re-run.
_Avoid_: Run, fetch, crawl, job

**Fetch attempt**:
One call a Scrape provider makes to fetch a URL on behalf of a Scrape. A Scrape makes one Fetch attempt unless the provider is configured to retry retryable failures; every Fetch attempt spends from the same Scrape deadline.
_Avoid_: Retry, Attempt (the Extraction ordinal)

**Scrape mode**:
How a Scrape is fetched: `basic` (headless browser, no proxy, no geo-targeting) or `advance` (third-party scraping service with a country). Always renders JavaScript in either mode. Each Retailer carries a default; a manual trigger may override it; the Scrape records the mode actually used.
_Avoid_: Provider, engine, strategy

**Scrape country**:
The geography an `advance` Scrape is fetched from. A Retailer default (`Australia`), overridable per manual trigger, meaningless in `basic` mode.
_Avoid_: Region, locale, geo

**Scrape envelope**:
The normalised result of a Scrape shared by both modes: final URL, status code, response headers, cookies, inner text (bounded in size), user agent, IP info, timing. Gaps one mode cannot fill are empty, not errors.
_Avoid_: Response, result, payload

**Scrape provider**:
The external capability that performs a fetch for a given Scrape mode. Providers are interchangeable behind the mode; the domain never names a vendor.
_Avoid_: Scraper, backend, integration

**Scrape status**:
The lifecycle of a Scrape: `pending → running → success | failed`. There is no `cancelled`.
_Avoid_: State, phase, outcome

**Scrape error code**:
Why a Scrape failed: `timeout` · `navigation_failed` · `blocked` · `provider_error` · `invalid_url` · `parent_deleted` · `unknown`. A non-2xx response from the target is _not_ a failure; it is a successful Scrape whose status code is product-level information. `parent_deleted` is only ever recorded on the Execution, never on a Scrape: a deleted Parent takes its Scrapes with it.
_Avoid_: Failure reason, error type

**Fetch success**:
A Scrape reached `success`: the HTML was captured and stored. Independent of whether any Extraction of it succeeded.
_Avoid_: Scrape success (ambiguous with the combined pill), done

**Last scraped at**:
The moment a Parent's most recent Scrape reached `success`. Advances only on fetch success; it reports, it does not schedule (see Cadence-due).
_Avoid_: Last run, last checked

**Stuck Scrape**:
A Scrape that has sat in `running` past a wall-clock bound. Swept to `failed` with error code `timeout`; its Execution is stopped and its stored objects removed as far as possible. Terminal states are final: an outcome the Execution produces after the sweep is discarded.
_Avoid_: Hung, zombie, orphan (see Orphan Execution)

### Execution and dispatch

**Execution**:
The durable unit of work that carries out one Scrape or one Extraction. The row is the source of truth for the outcome; the Execution is the durability mechanism that survives restarts. An Execution's identity is single-use: once it has existed, it can never be started again under the same identity.
_Avoid_: Run, workflow instance, job

**Execution status**:
Either **active** (`queued`, `running`, `waiting`, `paused`, `waitingForPause`), **terminal** (`complete`, `errored`, `terminated`) or **unresolved** (`unknown`, or the status could not be read). Distinct from Scrape status and Extraction status.
_Avoid_: Scrape status

**Dispatch**:
Pair a row with an Execution and start it. `dispatch(parent)` creates a fresh Scrape for a Parent and starts it; `redispatch(scrape)` starts an Execution for an existing `pending` Scrape. Extractions dispatch the same way.
_Avoid_: Trigger, enqueue, launch, kick off

**Dispatch outcome**:
The result of a Dispatch, as a value rather than an exception: `created`, `in-flight-skip` (the Parent already has an active Scrape), `already-active` (the Execution exists and is active), `recovered-failed` (the Execution exists and is terminal; the row was reconciled to `failed`).
_Avoid_: Dispatch error, dispatch result

**In-flight Parent**:
A Parent that already has a Scrape in `pending` or `running`. Dispatch refuses to create a second Scrape for it; this refusal, not runtime de-duplication, is what makes concurrent triggers safe.
_Avoid_: Busy, locked

**Orphan Execution**:
An Execution that exists for a row still in `pending`. Reconcile resolves it.
_Avoid_: Stuck Scrape, zombie

**Reconcile**:
On finding an Orphan Execution, consult its status: only a confirmed terminal status marks the row `failed` with error code `unknown` so the next tick can re-evaluate the Parent; active or unresolved leaves the row for a later tick.
_Avoid_: Repair, heal, sync

**Cron**:
The scheduled pickup that walks cadence-due Parents and pending rows every tick, with a per-tick cap on each. The safety net behind every other trigger: any `pending` row will eventually be picked up.
_Avoid_: Scheduler (ambiguous), poller, sweeper (see Sweep)

**Manual trigger**:
A user-initiated "Scrape now" or "Extract now" on one Parent or one Scrape. Bypasses pause; may override Scrape mode and country per call.
_Avoid_: On-demand, ad hoc, click

**Bulk trigger**:
"Scrape all" on a Brand, Product, or Retailer, or "Re-extract all" on a Retailer for one Parent kind. Creates every eligible row in `pending` at once and starts the first batch; Cron drains the rest. Respects effective pause. There is no bulk-job entity.
_Avoid_: Batch job, campaign, mass scrape

**Sweep**:
A scheduled housekeeping pass: the stuck sweep fails Stuck Scrapes, the retention sweep removes expired Scrapes.
_Avoid_: GC, cleanup, cron (see Cron)

### Scheduling and pause

**Cadence**:
How often a Parent is scraped: `daily | weekly | fortnightly | monthly`, default `monthly`. Set per Listing and per Page.
_Avoid_: Frequency, schedule, interval

**Cadence-due**:
A Parent whose most recent Scrape, whatever its outcome, is older than its cadence, or which has never been scraped. After a failed Scrape the wait is the shorter of the cadence and the Failure retry interval.
_Avoid_: Overdue, ready, scheduled

**Failure retry interval**:
How long a Parent whose most recent Scrape failed waits before it is cadence-due again, so a transient Retailer outage does not cost a whole cadence. One global setting, never shorter than a Cron tick.
_Avoid_: Backoff, retry cadence

**Pause**:
A toggle that stops scheduled scraping. Container-level on Brand, Product and Retailer; row-level on Page. Listings have no toggle of their own.
_Avoid_: Disable, deactivate, archive, mute

**Effective pause**:
Whether a Parent actually scrapes on cadence. A Listing is paused iff its Brand, Product, or Retailer is paused. A Page is paused iff its Brand or Retailer is paused, or its own toggle is on. Product never pauses Pages. Any paused ancestor wins over a due cadence.
_Avoid_: Inherited pause, paused state

### Extraction

**Extraction**:
One attempt to convert a successful Scrape's HTML into clean JSON using the Retailer's prompt for the Parent kind. Belongs to exactly one Scrape; many Extractions per Scrape are normal, and a new attempt never overwrites an old one.
_Avoid_: Parse, extract job, analysis

**Extraction status**:
The lifecycle of an Extraction: `pending → running → success | failed`.
_Avoid_: State, phase

**Extraction success**:
An Extraction reached `success`: the model produced parseable JSON. Independent of, and only possible after, fetch success.
_Avoid_: Extracted, done

**Extraction error code**:
Why an Extraction failed: `provider_error` · `json_mode_unmet` · `invalid_json` · `llm_timeout` · `context_overflow` · `unknown`.
_Avoid_: Extract failure, LLM error

**Attempt**:
The 1-based ordinal of an Extraction within its Scrape.
_Avoid_: Retry, version, revision

**Initial extract**:
The Extraction every successful Scrape automatically spawns, attempt 1.
_Avoid_: Auto-extract, first pass

**Re-extract**:
A new Extraction against an existing Scrape's stored HTML, without re-fetching, using the Retailer's _current_ prompt. Single (one Scrape) or bulk (every eligible Scrape on a Retailer for one Parent kind).
_Avoid_: Retry, re-run, re-parse

**Re-extract eligibility**:
Only a Scrape in `success` whose HTML is still within retention can be re-extracted. Scrapes with an Extraction already `pending` or `running` for that prompt kind are skipped in bulk to avoid duplicate attempts.
_Avoid_: Extractable

**Extraction prompt**:
The system prompt a Retailer holds per Parent kind: one for Listings, one for Pages. Seeded with defaults on Retailer creation and freely edited; there is no prompt versioning.
_Avoid_: Template, instruction, config

**Prompt snapshot**:
The literal prompt text an Extraction was run with, kept on the Extraction. The history of prompts that ever produced data is the set of distinct snapshots, not a separate entity.
_Avoid_: Prompt version, prompt history

**Prompt kind**:
Which Extraction prompt an Extraction used: `listing` or `page`. Equals the Parent kind of its Scrape.
_Avoid_: Prompt type

**Sanitised HTML**:
The model's input: a deterministic transformation of the stored HTML, computed at extract time and never stored. Strips scripts (except JSON-LD), styles, comments, class and inline style attributes, SVG and tracking attributes; keeps text, links, images, JSON-LD, microdata, meta tags, semantic elements and embedded widgets.
_Avoid_: Cleaned HTML, stripped HTML, DOM

**Extracted JSON**:
The clean structured output of a successful Extraction, stored on the Extraction itself. Small, structured, and read directly by downstream surfaces without normalising into a second schema.
_Avoid_: Result, output, data blob

**Extraction model**:
The LLM the Extraction ran against, recorded on the Extraction. Pinned as a global default with no per-Retailer override; the provider and model are configuration, not domain.
_Avoid_: Extract mode, engine

**Token usage**:
Prompt, completion and total tokens an Extraction consumed, kept on the Extraction.
_Avoid_: Cost, spend

**Latest Extraction**:
A Scrape's most recent Extraction attempt regardless of status.
_Avoid_: Current extraction, last attempt

**Latest successful Extraction**:
A Scrape's most recent Extraction in `success`. A failed Re-extract never displaces it, so the visible "last good data" survives.
_Avoid_: Latest extraction (ambiguous), good extraction

**Latest extracted data**:
The Extracted JSON of the latest successful Extraction of a Parent's most recent successful Scrape, as exposed to downstream analysis. Failed Extractions are never returned as clean data. Downstream surfaces return Listings as the canonical shape so multiple Listings for one `(Product, Retailer)` stay visible.
_Avoid_: Current data, live data, catalog data

**Combined status**:
The single dominant-failure reading of a Scrape's fetch and extraction states, ordered `failed > pending > running > success > none`. A density convenience; the two underlying statuses remain the truth.
_Avoid_: Scrape status (when both are meant), overall status

### Lifecycle of data

**Cascade**:
Every delete is a hard delete that removes all descendants: Brand → Products → Variants and Listings → Scrapes → Extractions, plus the Brand's Pages → Scrapes → Extractions; Product → Variants and Listings and below; Retailer → its Listings and Pages and below; Listing or Page → Scrapes → Extractions; Scrape → Extractions and its stored HTML. Deleting a Variant only removes it from Variant coverage; the Listings survive, even with empty coverage.
_Avoid_: Soft delete, archive, orphan cleanup

**Cascade impact**:
What a delete will remove, named before it happens (e.g. _"12 Products, 47 Variants, 31 Listings, 4 Pages, N Scrapes"_). Extractions are not counted separately; they follow their Scrape.
_Avoid_: Delete preview, blast radius

**Retention**:
The window after which a Scrape, its stored HTML and all its Extractions are removed by the retention sweep, anchored to the Scrape's creation. The product answers "what is on the retailer now", not a longitudinal archive.
_Avoid_: TTL, expiry, archive period, GC

### Identity and access

**User**:
An authenticated member of the single shared pool. Every User has full read and write access to every entity; there is no ownership and no tenancy boundary.
_Avoid_: Account, member, owner, tenant

**Authentication gate**:
The boundary between an unauthenticated caller (denied) and a User (full access). Only an email address at an allowlisted domain can become a User; the first sign-in creates them. Server-side work such as Cron, Sweeps and Executions runs inside the gate without a User.
_Avoid_: Authorisation, permissions, roles, tenancy

**Allowlisted domain**:
An email domain whose addresses may sign in. The complete list of who can enter the app; there is no per-person invitation or approval.
_Avoid_: Whitelist, tenant, organisation

## Invariants

- A Scrape has exactly one Parent: a Listing or a Page, never both, never neither.
- An Extraction belongs to exactly one Scrape and is only ever created against a Scrape in `success`.
- A Variant belongs to one Product and its name is unique within that Product.
- A Page is unique per `(Brand, Retailer)`. A Listing is not: `(Product, Retailer)` may hold many Listings, even sharing a URL.
- A Retailer's domain is unique globally.
- Brand names and Product names are not unique.
- A Scrape is one unit of work with one outcome, however many Fetch attempts its provider made.
- A Parent has at most one Scrape in `pending` or `running` at any moment; this, not cadence, is the hard guarantee. Overlapping Crons may rarely produce one extra Scrape within a cadence.
- A Scrape in `success` or `failed` never changes status again.
- Fetch success and Extraction success are independent states; neither implies the other.
- Last scraped at advances only on fetch success.
- Latest successful Extraction only ever moves forward to a newer `success`.
- Manual triggers bypass pause; Cron and bulk triggers respect effective pause.
- Deletion is always hard and always cascades.

## Open questions

Known drifts carried over from the previous app, to resolve in their own tickets rather than silently here.

- **Retention window**: the glossary and the sweep said 90 days; the earliest rebuild notes said 120 days. Pick one, never shorter than the longest cadence (the sweep would otherwise remove the Scrape that anchors Cadence-due), and note whether the per-tick sweep cap belongs in the domain at all.
- **URL invariants**: host-must-match-Retailer and tracker-param normalisation were deferred in the old app; not yet part of this glossary.
