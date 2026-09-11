/**
 * One-off InstantDB -> Postgres/R2 migration. Run with Node 26:
 *
 * pnpm --filter @digital-shelf/infra db:migrate-instantdb export --out snapshot.json
 * pnpm --filter @digital-shelf/infra db:migrate-instantdb load --snapshot snapshot.json --bucket digital-shelf-bucket-dev --since 2026-06-13T00:00:00Z --dry-run
 * pnpm --filter @digital-shelf/infra db:migrate-instantdb load --snapshot snapshot.json --bucket digital-shelf-bucket-dev --since 2026-06-13T00:00:00Z --exclude <id>,<id>
 *
 * export: INSTANT_APP_ID, INSTANT_ADMIN_TOKEN.
 * load: DATABASE_URL (direct Postgres), CLOUDFLARE_ACCOUNT_ID,
 * CLOUDFLARE_API_TOKEN, exported from the chosen stage's environment.
 * --dry-run is offline; review <snapshot>.report.json before loading. A load
 * must match its cutoff, exclusions and bucket; rerun --dry-run to change them.
 * --since defaults to now minus 90 days; --source-bucket to scrapes-html.
 * --replace truncates catalog/history in the transaction, leaving R2 objects;
 * it cannot accompany --dry-run. Load dev first, then prod after its deploy.
 * Pause the old cron before the final export; the operator owns cutover.
 * Exceptions stop loading until corrected or omitted with --exclude. Descendant
 * omissions are reported. Keep the snapshot frozen across reviews and retries.
 * Eight copy workers stop on failure; existing target keys are trusted and
 * skipped. A completed load requires --replace to run again. Migrated Scrapes
 * have synthetic root span ids with no historical trace (ADR 0007).
 */
import { canonicalDomain } from "@digital-shelf/core/Catalog/Retailers"
import { htmlKey, rawKey } from "@digital-shelf/core/Scraping/R2Keys"
import { Cadences } from "@digital-shelf/domain/Catalog/Cadence"
import { hostMatches } from "@digital-shelf/domain/Catalog/Retailer"
import {
  defaultScrapeMode,
  defaultScrapeCountry,
  defaultListingExtractPrompt,
  defaultPageExtractPrompt,
} from "@digital-shelf/domain/Catalog/RetailerManagement"
import {
  ScrapeModes,
  LifecycleStatuses,
  ParentKinds,
  ScrapeErrorCodes,
  ExtractionErrorCodes,
} from "@digital-shelf/domain/Scraping/Vocabulary"
import type { ScrapeId } from "@digital-shelf/domain/Shared/Ids"
import { Url } from "@digital-shelf/domain/Shared/Refine"
import * as Sql from "@digital-shelf/domain/Sql/index"
import { count, sql } from "drizzle-orm"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { Pool } from "pg"

const tables = {
  brands: Sql.brands,
  retailers: Sql.retailers,
  products: Sql.products,
  variants: Sql.variants,
  listings: Sql.listings,
  listing_variants: Sql.listingVariants,
  pages: Sql.pages,
  scrapes: Sql.scrapes,
  extractions: Sql.extractions,
}

type Table = keyof typeof tables

type EntityName = Exclude<Table, "listing_variants">

const SourceObject = Schema.Record(Schema.String, Schema.Unknown)

const Entity = Schema.StructWithRest(Schema.Struct({ id: Schema.String }), [
  SourceObject,
])

type Entity = typeof Entity.Type

type Snapshot = { exportedAt: string } & Record<EntityName, Entity[]>

type Rows = { [K in Table]: Array<(typeof tables)[K]["$inferInsert"]> }

interface Notice {
  entity: EntityName
  id: string
  field: string
  original: unknown
  reason: string
}

interface Copy {
  id: string
  html: { source: string; target: string } | null
  raw: { value: unknown; target: string } | null
}

interface TransformOptions {
  since: Date
  exclude: Set<string>
}

const entityNames = Object.keys(tables).filter(
  (name): name is EntityName => name !== "listing_variants",
)

const isRecord = Schema.is(SourceObject)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- InstantDB attributes are normalized before per-row validation so invalid values remain reportable.
const absentJson = (value: unknown) =>
  value == null ||
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Legacy empty objects and arrays both mean absent JSON; retain this normalization before validation.
  (typeof value === "object" && Object.keys(value).length === 0)
    ? null
    : value

type DropReason = "expired" | "excluded" | "invalid"

function problem(
  field: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Migration diagnostics retain the original invalid attribute without narrowing or discarding it.
  original: unknown,
  reason: string,
  omission: Exclude<DropReason, "expired"> | null = null,
): never {
  throw Object.assign(new Error(reason), {
    field,
    original: original ?? null,
    omission,
  })
}

const text = (r: Entity, field: string): string => {
  const value = Schema.decodeUnknownOption(Schema.String)(r[field])

  if (Option.isNone(value)) problem(field, r[field], "expected a string")

  return value.value
}

const optionalText = (r: Entity, field: string) =>
  r[field] == null ? null : text(r, field)

const absentText = (r: Entity, field: string) => optionalText(r, field) || null

const boolean = (r: Entity, field: string): boolean => {
  const value = Schema.decodeUnknownOption(Schema.Boolean)(r[field])

  if (Option.isNone(value)) problem(field, r[field], "expected a boolean")

  return value.value
}

const integer = (r: Entity, field: string): number | null => {
  const value = r[field]

  if (value == null) return null

  const number = Schema.decodeUnknownOption(Schema.Number)(value)

  if (Option.isNone(number)) problem(field, value, "expected a number")

  return number.value
}

const TimestampText = Schema.String.check(
  Schema.isPattern(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/,
  ),
)

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This decoder accepts raw snapshot timestamps and reports invalid values against their source field.
const date = (value: unknown, field: string): Date => {
  const timestamp = Schema.decodeUnknownOption(TimestampText)(value)

  if (Option.isNone(timestamp)) {
    problem(field, value, "expected an ISO timestamp with timezone")
  }

  const result = new Date(timestamp.value)

  if (!Number.isFinite(result.getTime()))
    problem(field, value, "invalid timestamp")

  return result
}

const optionalDate = (r: Entity, field: string) =>
  r[field] == null ? null : date(r[field], field)

const timestamps = (r: Entity) => ({
  id: r.id,
  createdAt: date(r.createdAt, "createdAt"),
  updatedAt: date(r.updatedAt, "updatedAt"),
})

const LinkedEntity = Schema.Struct({ id: Schema.String })

const links = (r: Entity, field: string): string[] => {
  const value = r[field]

  if (!Array.isArray(value))
    return problem(field, value, "expected an array of link ids")

  return value.map((link) => {
    const linked = Schema.decodeUnknownOption(LinkedEntity)(link)

    if (Option.isNone(linked)) {
      return problem(field, value, "expected a linked id")
    }

    return linked.value.id
  })
}

const one = (r: Entity, field: string) => {
  const ids = links(r, field)

  if (ids.length !== 1)
    problem(field, r[field], "requires exactly one linked entity")

  return ids[0]!
}

const literal = <A extends string>(
  values: readonly A[],
  field: string,
  value: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Audit reports retain the pre-normalization InstantDB value when a literal is invalid.
  original: unknown = value,
): A => {
  const match = values.find((allowed) => allowed === value)

  if (match === undefined)
    problem(field, original, `expected one of: ${values.join(", ")}`)

  return match
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the JSON input boundary; decode the envelope and ids before per-row attribute validation.
const snapshotFrom = (value: unknown): Snapshot => {
  const decoded = Schema.decodeUnknownOption(SourceObject)(value)

  if (Option.isNone(decoded)) throw new Error("Snapshot must be an object")
  const snapshot = decoded.value
  date(snapshot.exportedAt, "exportedAt")

  for (const entity of entityNames) {
    const rows = Schema.decodeUnknownOption(Schema.Array(Entity))(
      snapshot[entity],
    )

    if (Option.isNone(rows)) {
      throw new Error(`Snapshot ${entity} must contain objects with string ids`)
    }
  }

  // SAFETY: The envelope and ids were checked above. Attribute validation is per
  // row below, so invalid source data can be reported and excluded by id.
  return snapshot as Snapshot
}

function transform(snapshot: Snapshot, options: TransformOptions) {
  const rows: Rows = {
    brands: [],
    retailers: [],
    products: [],
    variants: [],
    listings: [],
    listing_variants: [],
    pages: [],
    scrapes: [],
    extractions: [],
  }

  const exceptions: Notice[] = []
  const decisions: Notice[] = []
  const objects: Copy[] = []

  const dropped = {
    expiredScrapes: 0,
    expiredExtractions: 0,
    excludedScrapes: 0,
    excludedExtractions: 0,
    invalidScrapes: 0,
    invalidExtractions: 0,
  }

  const omitted = new Map<string, Exclude<DropReason, "expired">>(
    [...options.exclude].map((id) => [id, "excluded"]),
  )

  const expired = new Set<string>()
  const held = new Map(entityNames.map((name) => [name, new Set<string>()]))
  const exportedAt = date(snapshot.exportedAt, "exportedAt")

  const drop = (entity: EntityName, reason: DropReason) => {
    if (entity === "scrapes") dropped[`${reason}Scrapes`]++

    if (entity === "extractions") dropped[`${reason}Extractions`]++
  }

  const decide = (
    entity: EntityName,
    r: Entity,
    field: string,
    reason: string,
  ) =>
    decisions.push({
      entity,
      id: r.id,
      field,
      original: r[field] ?? null,
      reason,
    })

  const ref = (entity: EntityName, id: string, field: string) => {
    const reason = omitted.get(id)

    if (reason) problem(field, id, `omitted with ${reason} dependency`, reason)

    if (!held.get(entity)!.has(id))
      problem(field, id, `missing or invalid ${entity} dependency`)

    return id
  }

  const each = (entity: EntityName, convert: (r: Entity) => void) => {
    for (const r of snapshot[entity]) {
      const reason = omitted.get(r.id)

      if (reason) {
        decide(entity, r, "id", `${reason} by id`)
        drop(entity, reason)
        continue
      }

      try {
        if (
          entity === "scrapes" &&
          date(r.createdAt, "createdAt") < options.since
        ) {
          expired.add(r.id)
          drop(entity, "expired")
          continue
        }

        if (entity === "extractions" && expired.has(one(r, "scrape"))) {
          drop(entity, "expired")
          continue
        }

        convert(r)
        held.get(entity)!.add(r.id)
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("field" in error) ||
          !("original" in error) ||
          !("omission" in error)
        )
          throw error

        const notice = {
          entity,
          id: r.id,
          field: String(error.field),
          original: error.original,
          reason: error.message,
        }

        const reason = error.omission === "excluded" ? "excluded" : "invalid"
        omitted.set(r.id, reason)
        drop(entity, reason)

        if (error.omission === null) exceptions.push(notice)
        else decisions.push(notice)
      }
    }
  }

  each("brands", (r) => {
    rows.brands.push({
      ...timestamps(r),
      name: text(r, "name"),
      paused: boolean(r, "paused"),
    })
  })
  const domains = new Map<string, string>()
  each("retailers", (r) => {
    const domain = canonicalDomain(text(r, "domain"))

    if (Option.isNone(domain))
      return problem("domain", r.domain, "invalid canonical Retailer domain")
    const holder = domains.get(domain.value)

    if (holder)
      problem(
        "domain",
        r.domain,
        `canonical domain ${domain.value} collides with ${holder}; never merged`,
      )

    const defaulted = (field: string, fallback: string) => {
      const value = optionalText(r, field)

      if (value !== null) return value
      decide("retailers", r, field, `defaulted to ${fallback}`)

      return fallback
    }

    rows.retailers.push({
      ...timestamps(r),
      name: text(r, "name"),
      paused: boolean(r, "paused"),
      domain: domain.value,
      scrapeMode: literal(
        ScrapeModes,
        "scrapeMode",
        defaulted("scrapeMode", defaultScrapeMode),
      ),
      scrapeCountry: defaulted("scrapeCountry", defaultScrapeCountry),
      listingExtractPrompt: defaulted(
        "listingExtractPrompt",
        defaultListingExtractPrompt,
      ),
      pageExtractPrompt: defaulted(
        "pageExtractPrompt",
        defaultPageExtractPrompt,
      ),
    })
    domains.set(domain.value, r.id)
  })
  each("products", (r) => {
    rows.products.push({
      ...timestamps(r),
      name: text(r, "name"),
      paused: boolean(r, "paused"),
      brandId: ref("brands", one(r, "brand"), "brand"),
    })
  })
  const variantNames = new Set<string>()
  each("variants", (r) => {
    const productId = ref("products", one(r, "product"), "product")
    const name = text(r, "name")
    const unique = `${productId}:${name.toLowerCase()}`

    if (variantNames.has(unique))
      problem(
        "name",
        name,
        "duplicate Variant name within Product, ignoring case",
      )
    rows.variants.push({ ...timestamps(r), productId, name })
    variantNames.add(unique)
  })

  const parentFields = (entity: "listings" | "pages", r: Entity) => {
    const retailerId = ref("retailers", one(r, "retailer"), "retailer")
    const domain = rows.retailers.find((row) => row.id === retailerId)!.domain
    let url = text(r, "url").trim()

    if (
      !/^[a-z][a-z0-9+.-]*:/i.test(url) &&
      hostMatches(`https://${url}`, domain)
    ) {
      url = `https://${url}`
      decide(
        entity,
        r,
        "url",
        "prefixed https:// after matching the Retailer host",
      )
    }

    try {
      url = Schema.decodeUnknownSync(Url)(url)
    } catch (error) {
      problem("url", r.url, String(error))
    }

    if (!hostMatches(url, domain))
      problem("url", r.url, `URL host does not match Retailer ${domain}`)

    return {
      ...timestamps(r),
      retailerId,
      url,
      cadence: literal(
        Cadences,
        "cadence",
        text(r, "cadence").toLowerCase(),
        r.cadence,
      ),
      lastScrapedAt: optionalDate(r, "lastScrapedAt"),
    }
  }

  each("listings", (r) => {
    const productId = ref("products", one(r, "product"), "product")
    const fields = parentFields("listings", r)
    const coverage = new Set<string>()

    for (const id of links(r, "variants")) {
      if (omitted.has(id)) {
        decide(
          "listings",
          r,
          "variants",
          `coverage edge to ${omitted.get(id)} Variant ${id} omitted`,
        )
        continue
      }

      ref("variants", id, "variants")

      if (rows.variants.find((v) => v.id === id)!.productId !== productId)
        problem("variants", r.variants, "Variant belongs to another Product")

      if (coverage.has(id))
        problem("variants", r.variants, "duplicate coverage edge")
      coverage.add(id)
    }

    rows.listings.push({ ...fields, productId })

    for (const variantId of coverage)
      rows.listing_variants.push({ listingId: r.id, variantId })
  })
  const pagePairs = new Set<string>()
  each("pages", (r) => {
    const brandId = ref("brands", one(r, "brand"), "brand")
    const fields = parentFields("pages", r)
    const pair = `${brandId}:${fields.retailerId}`

    if (pagePairs.has(pair))
      problem("retailer", r.retailer, "duplicate Page for Brand and Retailer")
    rows.pages.push({ ...fields, brandId, paused: boolean(r, "paused") })
    pagePairs.add(pair)
  })

  const errorCode = (
    entity: EntityName,
    r: Entity,
    field: string,
    codes: readonly string[],
  ) => {
    const code = absentText(r, field)

    if (code === null) return null

    if (code === "schema_mismatch") {
      decide(entity, r, field, "mapped retired schema_mismatch to unknown")

      return "unknown"
    }

    return literal(codes, field, code)
  }

  const stuckMessage = "stuck in-flight at InstantDB migration"
  each("scrapes", (r) => {
    const listing = links(r, "listing")
    const page = links(r, "page")

    if (listing.length + page.length !== 1)
      problem(
        "parent",
        { listing: r.listing, page: r.page },
        "Scrape requires exactly one Listing or Page",
      )
    const listingId = listing[0] ? ref("listings", listing[0], "listing") : null
    const pageId = page[0] ? ref("pages", page[0], "page") : null
    const status = literal(LifecycleStatuses, "status", text(r, "status"))
    const inFlight = status === "running" || status === "pending"
    // SAFETY: InstantDB ids identify Scrapes; Postgres validates UUID syntax.
    const id = r.id as ScrapeId

    // ADR 0007: random ids satisfy the CHECK; no historical root was emitted.
    const rootSpanId = Array.from(
      crypto.getRandomValues(new Uint8Array(8)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")

    const htmlR2Key = absentText(r, "htmlR2Key") === null ? null : htmlKey(id)
    const raw = absentJson(r.raw)
    const rawR2Key = raw === null ? null : rawKey(id)
    const requestHeaders = absentJson(r.requestHeaders)

    if (requestHeaders !== null && !isRecord(requestHeaders))
      problem("requestHeaders", requestHeaders, "expected a JSON object")
    const statusCode = integer(r, "statusCode")

    const row = {
      ...timestamps(r),
      listingId,
      pageId,
      rootSpanId,
      mode: literal(ScrapeModes, "mode", text(r, "mode")),
      status: inFlight ? ("failed" as const) : status,
      errorCode: inFlight
        ? "timeout"
        : errorCode("scrapes", r, "errorCode", ScrapeErrorCodes),
      errorMessage: inFlight ? stuckMessage : absentText(r, "errorMessage"),
      startedAt: optionalDate(r, "startedAt"),
      finishedAt: inFlight ? exportedAt : optionalDate(r, "finishedAt"),
      country: absentText(r, "country"),
      requestUrl: text(r, "requestUrl"),
      requestHeaders,
      htmlR2Key,
      rawR2Key,
      finalUrl: absentText(r, "finalUrl"),
      statusCode: statusCode === 0 ? null : statusCode,
      responseHeaders: absentJson(r.responseHeaders),
      cookies: absentJson(r.cookies),
      innerText: absentText(r, "innerText"),
      userAgent: absentText(r, "userAgent"),
      ipInfo: absentJson(r.ipInfo),
      type: absentText(r, "type"),
      session: absentText(r, "session"),
      attempts: null,
    }

    rows.scrapes.push(row)

    if (inFlight)
      decide(
        "scrapes",
        r,
        "status",
        "failed stuck in-flight Scrape with timeout at exportedAt",
      )
    objects.push({
      id,
      html:
        htmlR2Key === null
          ? null
          : { source: `scrapes/${id}.html`, target: htmlR2Key },
      raw: rawR2Key === null ? null : { value: raw, target: rawR2Key },
    })
  })
  const attempts = new Set<string>()
  each("extractions", (r) => {
    const scrapeId = ref("scrapes", one(r, "scrape"), "scrape")
    const scrape = rows.scrapes.find((s) => s.id === scrapeId)!
    const promptKind = literal(ParentKinds, "promptKind", text(r, "promptKind"))

    if (promptKind !== (scrape.listingId === null ? "page" : "listing"))
      problem(
        "promptKind",
        r.promptKind,
        "prompt kind differs from Scrape Parent kind",
      )
    const attempt = integer(r, "attempt")

    if (attempt === null || attempt < 1)
      problem("attempt", r.attempt, "expected a positive attempt")
    const unique = `${scrapeId}:${attempt}`

    if (attempts.has(unique))
      problem("attempt", attempt, "duplicate Extraction attempt for Scrape")
    const status = literal(LifecycleStatuses, "status", text(r, "status"))

    const inFlight = status === "pending" || status === "running"

    const tokens = (field: string) => {
      const value = integer(r, field)

      return status !== "success" && value === 0 ? null : value
    }

    rows.extractions.push({
      ...timestamps(r),
      scrapeId,
      attempt,
      promptKind,
      status: inFlight ? "failed" : status,
      promptSnapshot: text(r, "promptSnapshot"),
      model: "@cf/zai-org/glm-4.7-flash",
      startedAt: optionalDate(r, "startedAt"),
      finishedAt: inFlight ? exportedAt : optionalDate(r, "finishedAt"),
      errorCode: inFlight
        ? "unknown"
        : errorCode("extractions", r, "extractErrorCode", ExtractionErrorCodes),
      errorMessage: inFlight
        ? stuckMessage
        : absentText(r, "extractErrorMessage"),
      extractedJson: r.extractedJson ?? null,
      promptTokens: tokens("promptTokens"),
      completionTokens: tokens("completionTokens"),
      totalTokens: tokens("totalTokens"),
    })
    attempts.add(unique)

    if (inFlight)
      decide(
        "extractions",
        r,
        "status",
        "failed stuck in-flight Extraction with unknown at exportedAt",
      )
  })

  return { rows, objects, exceptions, decisions, dropped }
}

const env = (name: string) => {
  const value = process.env[name]

  if (!value) throw new Error(`Missing ${name}`)

  return value
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON.stringify accepts arbitrary snapshots and reports, including invalid original attributes retained for audit.
async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function exportSnapshot(out: string) {
  const ids = { $: { fields: ["id"] } }

  const query = {
    brands: {},
    retailers: {},
    products: { brand: ids },
    variants: { product: ids },
    listings: { product: ids, retailer: ids, variants: ids },
    pages: { brand: ids, retailer: ids },
    scrapes: { listing: ids, page: ids },
    extractions: { scrape: ids },
  }

  const response = await fetch("https://api.instantdb.com/admin/query", {
    method: "POST",
    signal: AbortSignal.timeout(120_000),
    headers: {
      "app-id": env("INSTANT_APP_ID"),
      authorization: `Bearer ${env("INSTANT_ADMIN_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  })

  if (!response.ok) throw new Error(`InstantDB query: HTTP ${response.status}`)
  const data: unknown = await response.json()

  if (!isRecord(data)) throw new Error("Invalid InstantDB query response")

  // No attribute projection or transform: this file is the complete audit copy.
  const snapshot = snapshotFrom({
    ...data,
    exportedAt: new Date().toISOString(),
  })

  await writeJson(out, snapshot)
  console.table(
    entityNames.map((table) => ({ table, rows: snapshot[table].length })),
  )
  console.log(`Snapshot written to ${out}`)
}

const R2Listing = Schema.Struct({
  success: Schema.Literal(true),
  result: Schema.Array(Schema.Unknown),
  result_info: Schema.optional(Schema.Unknown),
})

const R2Object = Schema.Struct({ key: Schema.String })

const R2PageInfo = Schema.Struct({ cursor: Schema.String })

function r2(bucket: string, account: string, token: string) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/r2/buckets/${encodeURIComponent(bucket)}/objects`

  const request = (suffix: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set("authorization", `Bearer ${token}`)

    return fetch(`${base}${suffix}`, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(init.signal ? [init.signal] : []),
      ]),
      headers,
    })
  }

  const check = (response: Response) => {
    if (!response.ok) throw new Error(`R2 ${bucket}: HTTP ${response.status}`)
  }

  return {
    async list() {
      const keys = new Set<string>()
      let cursor: string | undefined

      do {
        const query = new URLSearchParams({ per_page: "1000" })

        if (cursor) query.set("cursor", cursor)
        const response = await request(`?${query}`)
        check(response)

        const data = Schema.decodeUnknownOption(R2Listing)(
          await response.json(),
        )

        if (Option.isNone(data)) throw new Error("Invalid R2 object listing")

        for (const object of data.value.result) {
          const decoded = Schema.decodeUnknownOption(R2Object)(object)

          if (Option.isNone(decoded))
            throw new Error("Invalid key in R2 listing")
          keys.add(decoded.value.key)
        }

        const info = Schema.decodeUnknownOption(R2PageInfo)(
          data.value.result_info,
        )

        cursor = Option.getOrUndefined(Option.map(info, (page) => page.cursor))
      } while (cursor)

      return keys
    },
    async get(key: string, signal: AbortSignal) {
      const response = await request(`/${encodeURIComponent(key)}`, { signal })

      if (response.status === 404) return null
      check(response)

      return new Uint8Array(await response.arrayBuffer())
    },
    async put(
      key: string,
      body: Uint8Array<ArrayBuffer> | string,
      contentType: string,
      signal: AbortSignal,
    ) {
      const response = await request(`/${encodeURIComponent(key)}`, {
        method: "PUT",
        body,
        headers: { "content-type": contentType },
        signal,
      })

      check(response)
      const result: unknown = await response.json()

      if (!isRecord(result) || result.success !== true)
        throw new Error(`R2 did not confirm writing ${key}`)
    },
  }
}

async function copyObjects(
  result: ReturnType<typeof transform>,
  source: ReturnType<typeof r2>,
  target: ReturnType<typeof r2>,
) {
  const present = await target.list()
  const abort = new AbortController()
  const queue = result.objects.values()
  let copied = 0
  let skipped = 0

  await Promise.all(
    Array.from({ length: 8 }, async () => {
      try {
        for (const object of queue) {
          for (const entry of [object.html, object.raw]) {
            if (entry === null) continue
            abort.signal.throwIfAborted()

            if (present.has(entry.target)) {
              skipped++
              continue
            }

            let body: Uint8Array<ArrayBuffer> | string

            if ("source" in entry) {
              const html = await source.get(entry.source, abort.signal)

              if (html === null) {
                result.exceptions.push({
                  entity: "scrapes",
                  id: object.id,
                  field: "htmlR2Key",
                  original: entry.source,
                  reason: "source R2 object is missing",
                })
                throw new Error(
                  `Missing source object ${entry.source}; restore it or exclude Scrape ${object.id}`,
                )
              }

              body = html
            } else body = JSON.stringify(entry.value)
            await target.put(
              entry.target,
              body,
              "source" in entry ? "text/html" : "application/json",
              abort.signal,
            )
            present.add(entry.target)
            copied++
          }
        }
      } catch (error) {
        abort.abort(error)
      }
    }),
  )

  console.table([{ copied, skipped, exceptions: result.exceptions.length }])

  abort.signal.throwIfAborted()
}

async function counts(db: NodePgDatabase) {
  const counts = new Map<Table, number>()

  for (const [name, table] of Object.entries(tables)) {
    const [row] = await db.select({ count: count() }).from(table)
    // SAFETY: These names are exactly the keys of the closed tables object.
    counts.set(name as Table, Number(row!.count))
  }

  return counts
}

async function insertRows(url: string, rows: Rows, replace: boolean) {
  const pool = new Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 30_000,
  })

  try {
    const client = await pool.connect()

    try {
      const db = drizzle({ client })
      await client.query("BEGIN")

      try {
        const occupied = [...(await counts(db))].filter(
          ([, count]) => count !== 0,
        )

        if (occupied.length && !replace)
          throw new Error(
            `Target is not empty: ${occupied.map(([name, n]) => `${name}=${n}`).join(", ")}; use --replace deliberately`,
          )

        if (replace)
          await db.execute(sql`TRUNCATE brands, retailers, scrapes CASCADE`)

        // Bound parameters stay below Postgres's 65,535 limit. All batches
        // share this one connection and transaction, in foreign-key order.
        for (const name of Object.keys(tables)) {
          // SAFETY: The closed table map and Rows share the same key set.
          const table = name as Table

          for (let i = 0; i < rows[table].length; i += 250) {
            await db.insert(tables[table]).values(rows[table].slice(i, i + 250))
          }
        }

        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      }

      return {
        counts: await counts(db),
        scrapes: await db
          .select({
            id: Sql.scrapes.id,
            htmlR2Key: Sql.scrapes.htmlR2Key,
            rawR2Key: Sql.scrapes.rawR2Key,
          })
          .from(Sql.scrapes),
      }
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

const help = `Usage: node packages/infra/scripts/migrate-instantdb.ts <export|load>
  export --out <snapshot.json>
  load --snapshot <snapshot.json> --bucket <target-bucket>
       [--source-bucket scrapes-html] [--since <ISO>] [--exclude <id>,<id>]
       [--replace | --dry-run]

Dry-run transforms and writes <snapshot>.report.json entirely offline.
Load must match the report's --since, --exclude and --bucket.
See the script header for environment variables and cutover procedure.`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      out: { type: "string" },
      snapshot: { type: "string" },
      bucket: { type: "string" },
      "source-bucket": { type: "string" },
      since: { type: "string" },
      exclude: { type: "string" },
      replace: { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
  })

  if (values.help) {
    console.log(help)

    return
  }

  const [command] = positionals

  if (positionals.length !== 1 || (command !== "export" && command !== "load"))
    throw new Error(help)

  const invalidOption = Object.keys(values).find((name) =>
    command === "export" ? name !== "out" : name === "out",
  )

  if (invalidOption)
    throw new Error(`--${invalidOption} is not an option for ${command}`)

  if (command === "export") {
    if (!values.out) throw new Error("export requires --out")
    await exportSnapshot(values.out)

    return
  }

  if (!values.snapshot || !values.bucket)
    throw new Error("load requires --snapshot and --bucket")

  if (values.replace && values["dry-run"])
    throw new Error("--replace cannot be combined with --dry-run")
  const sourceBucket = values["source-bucket"] ?? "scrapes-html"

  if (sourceBucket === values.bucket)
    throw new Error("Source and target buckets must differ")

  const snapshot = snapshotFrom(
    JSON.parse(await readFile(values.snapshot, "utf8")),
  )

  const since = values.since
    ? date(values.since, "since")
    : new Date(Date.now() - 90 * 86_400_000)

  const exclude = new Set(
    (values.exclude ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  )

  const scope = {
    since: since.toISOString(),
    exclude: [...exclude].sort(),
    bucket: values.bucket,
  }

  const reportFile = `${values.snapshot}.report.json`

  if (!values["dry-run"]) {
    const previous = await readFile(reportFile, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null
        throw error
      },
    )

    if (previous !== null) {
      const saved: typeof scope = JSON.parse(previous)

      const reviewed = {
        since: saved.since,
        exclude: [...new Set(saved.exclude)].sort(),
        bucket: saved.bucket,
      }

      if (JSON.stringify(reviewed) !== JSON.stringify(scope))
        throw new Error(
          `Load flags differ from the reviewed report.\nReviewed: ${JSON.stringify(reviewed)}\nCurrent:  ${JSON.stringify(scope)}\nRun --dry-run to review the new flags before loading.`,
        )
    }
  }

  const knownIds = new Set(
    entityNames.flatMap((entity) => snapshot[entity].map((r) => r.id)),
  )

  for (const id of exclude)
    if (!knownIds.has(id))
      throw new Error(`Excluded id is not in the snapshot: ${id}`)

  const result = transform(snapshot, { since, exclude })

  const summary = Object.entries(result.rows).map(([table, rows]) => ({
    table,
    rows: rows.length,
  }))

  const objectsToCopy = {
    htmlObjects: result.objects.filter((object) => object.html !== null).length,
    rawObjects: result.objects.filter((object) => object.raw !== null).length,
  }

  console.table(summary)
  console.table([
    {
      decisions: result.decisions.length,
      exceptions: result.exceptions.length,
      ...result.dropped,
    },
  ])
  console.table([objectsToCopy])

  const report = {
    snapshot: values.snapshot,
    exportedAt: snapshot.exportedAt,
    ...scope,
    sourceBucket,
    summary,
    objectsToCopy,
    decisions: result.decisions,
    exceptions: result.exceptions,
    dropped: result.dropped,
  }

  await writeJson(reportFile, report)
  console.log(`Report written to ${reportFile}`)

  if (result.exceptions.length)
    throw new Error(
      "Unexcluded exceptions remain; review the report before loading",
    )

  if (values["dry-run"]) return
  const databaseUrl = env("DATABASE_URL")
  const account = env("CLOUDFLARE_ACCOUNT_ID")
  const token = env("CLOUDFLARE_API_TOKEN")
  const target = r2(values.bucket, account, token)

  try {
    await copyObjects(result, r2(sourceBucket, account, token), target)

    await writeJson(reportFile, report)

    const actual = await insertRows(
      databaseUrl,
      result.rows,
      values.replace ?? false,
    )

    // SAFETY: The summary was created from Rows, whose keys are Table names.
    const comparison = summary.map(({ table, rows }) => ({
      table,
      expected: rows,
      actual: actual.counts.get(table as Table),
      matches: actual.counts.get(table as Table) === rows,
    }))

    const stored = await target.list()

    const missingObjects = actual.scrapes.flatMap((r) =>
      [r.htmlR2Key, r.rawR2Key].flatMap((key) =>
        key && !stored.has(key) ? [{ id: r.id, key }] : [],
      ),
    )

    console.table(comparison)
    console.log(
      `R2 references: ${missingObjects.length === 0 ? "all present" : `${missingObjects.length} missing`}`,
    )
    await writeJson(reportFile, {
      ...report,
      verification: { comparison, missingObjects },
    })

    if (comparison.some((row) => !row.matches) || missingObjects.length)
      throw new Error(
        "Post-load verification failed; rows have committed, see report",
      )
  } catch (error) {
    // Preserve verification details when a failure happens after COMMIT.
    const saved = JSON.parse(await readFile(reportFile, "utf8"))
    await writeJson(reportFile, {
      ...saved,
      exceptions: result.exceptions,
      loadError: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejection reasons are unconstrained; the CLI only renders this final failure.
await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
