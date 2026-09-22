import { RetailersErrors } from "./retailers/errors"
import type { RetailerId } from "@app/schema/ids"
import { Retailer } from "@app/schema/retailer"
import { type CascadeImpact, CascadeRoot } from "@app/schema/cascade"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Db } from "@app/db"
import { Cascade } from "./cascade"
import { RetailersRepo } from "./retailers/repository"

export * as Retailers from "./retailers"

export { RetailersErrors } from "./retailers/errors"

export interface Interface {
  readonly getForShare: (
    input: Retailer.GetForShareInput,
  ) => Effect.Effect<Retailer.Info, RetailersErrors.NotFound | SqlError>
  readonly create: (
    command: Retailer.Create,
  ) => Effect.Effect<
    Retailer.Info,
    RetailersErrors.InvalidDomain | RetailersErrors.DomainTaken | SqlError
  >
  readonly update: (
    input: Retailer.UpdateInput,
  ) => Effect.Effect<
    Retailer.Info,
    | RetailersErrors.NotFound
    | RetailersErrors.InvalidDomain
    | RetailersErrors.DomainTaken
    | RetailersErrors.UrlHostMismatch
    | SqlError
  >
  readonly get: (
    input: Retailer.GetInput,
  ) => Effect.Effect<Retailer.Info, RetailersErrors.NotFound | SqlError>
  readonly list: Effect.Effect<ReadonlyArray<Retailer.Info>, SqlError>
  readonly remove: (
    input: Retailer.RemoveInput,
  ) => Effect.Effect<CascadeImpact, RetailersErrors.NotFound | SqlError>
  readonly impact: (
    input: Retailer.ImpactInput,
  ) => Effect.Effect<CascadeImpact, RetailersErrors.NotFound | SqlError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/retailers",
) {}

const make = Effect.gen(function* () {
  const db = yield* Db
  const cascade = yield* Cascade.Service
  const repo = yield* RetailersRepo.Service

  /**
   * Every child URL that the new domain would leave stranded. The Retailer row
   * is already locked `FOR UPDATE` when this runs, so no concurrent child write
   * can add one behind it.
   */
  const refuseStrandedChildren = Effect.fn("Retailers.refuseStrandedChildren")(
    function* (id: RetailerId, domain: Retailer.Domain) {
      const listings = (yield* repo.listingUrls(id)).filter(
        (row) => !Retailer.hostMatches(row.url, domain),
      )

      const pages = (yield* repo.pageUrls(id)).filter(
        (row) => !Retailer.hostMatches(row.url, domain),
      )

      const first = listings[0] ?? pages[0]

      if (first === undefined) return

      return yield* Effect.fail(
        new RetailersErrors.UrlHostMismatch({
          url: first.url,
          domain,
          listingIds: listings.map((row) => row.id),
          pageIds: pages.map((row) => row.id),
        }),
      )
    },
  )

  const taken = (domain: Retailer.Domain) =>
    Effect.gen(function* () {
      const holder = yield* repo.findByDomain(domain)

      if (Option.isNone(holder))
        return yield* Effect.die(
          new Error(
            "Conflicting Retailer disappeared before its domain could be identified",
          ),
        )

      return yield* Effect.fail(
        new RetailersErrors.DomainTaken({
          domain,
          retailerId: holder.value.id,
        }),
      )
    })

  const create = Effect.fn("Retailers.create")(function* (
    command: Retailer.Create,
  ) {
    const domain = yield* requireDomain(command.domain)

    const insert = db.transaction(() =>
      repo.insert({
        ...command,
        domain,
        paused: command.paused ?? false,
        scrapeMode: command.scrapeMode ?? Retailer.defaultScrapeMode,
        scrapeCountry: command.scrapeCountry ?? Retailer.defaultScrapeCountry,
        listingExtractPrompt:
          command.listingExtractPrompt ?? Retailer.defaultListingExtractPrompt,
        pageExtractPrompt:
          command.pageExtractPrompt ?? Retailer.defaultPageExtractPrompt,
      }),
    )

    return yield* insert.pipe(
      Effect.catchTag("DomainTaken", () =>
        Effect.gen(function* () {
          const holder = yield* repo.findByDomain(domain)

          if (Option.isNone(holder))
            return yield* insert.pipe(
              Effect.catchTag("DomainTaken", () => taken(domain)),
            )

          return yield* Effect.fail(
            new RetailersErrors.DomainTaken({
              domain,
              retailerId: holder.value.id,
            }),
          )
        }),
      ),
    )
  })

  const update = Effect.fn("Retailers.update")(function* (
    input: Retailer.UpdateInput,
  ) {
    const { domain: domainInput, ...patch } = input.command

    const domain =
      domainInput === undefined ? undefined : yield* requireDomain(domainInput)

    return yield* db
      .transaction(() =>
        Effect.gen(function* () {
          if (domain !== undefined) {
            // The lock excludes child writes until this transaction commits,
            // so a Listing or Page cannot slip past the check below on the
            // old domain and land under the new one.
            yield* repo.getForUpdate(input.retailerId).pipe(
              Effect.catchTag("MissingRetailer", (error) =>
                Effect.fail(
                  new RetailersErrors.NotFound({
                    retailerId: error.retailerId,
                  }),
                ),
              ),
            )
            yield* refuseStrandedChildren(input.retailerId, domain)
          }

          return yield* repo
            .update(
              input.retailerId,
              domain === undefined ? patch : { ...patch, domain },
            )
            .pipe(
              Effect.catchTag("MissingRetailer", (error) =>
                Effect.fail(
                  new RetailersErrors.NotFound({
                    retailerId: error.retailerId,
                  }),
                ),
              ),
            )
        }),
      )
      .pipe(
        Effect.catchTag("DomainTaken", () =>
          domain === undefined
            ? Effect.die(new Error("Domain conflict without a domain change"))
            : taken(domain),
        ),
      )
  })

  const get = Effect.fn("Retailers.get")(function* (input: Retailer.GetInput) {
    return yield* repo
      .get(input.retailerId)
      .pipe(
        Effect.catchTag("MissingRetailer", (error) =>
          Effect.fail(
            new RetailersErrors.NotFound({ retailerId: error.retailerId }),
          ),
        ),
      )
  })

  const list = repo.list.pipe(Effect.withSpan("Retailers.list"))

  const impact = Effect.fn("Retailers.impact")(function* (
    input: Retailer.ImpactInput,
  ) {
    yield* repo
      .get(input.retailerId)
      .pipe(
        Effect.catchTag("MissingRetailer", (error) =>
          Effect.fail(
            new RetailersErrors.NotFound({ retailerId: error.retailerId }),
          ),
        ),
      )

    return yield* cascade.impact(CascadeRoot.Retailer({ id: input.retailerId }))
  })

  const remove = Effect.fn("Retailers.remove")(function* (
    input: Retailer.RemoveInput,
  ) {
    return (yield* cascade.remove(
      CascadeRoot.Retailer({ id: input.retailerId }),
      repo
        .remove(input.retailerId)
        .pipe(
          Effect.catchTag("MissingRetailer", (error) =>
            Effect.fail(
              new RetailersErrors.NotFound({ retailerId: error.retailerId }),
            ),
          ),
        ),
    )).impact
  })

  const getForShare = (input: Retailer.GetForShareInput) =>
    repo
      .getForShare(input.retailerId)
      .pipe(
        Effect.catchTag("MissingRetailer", (error) =>
          Effect.fail(
            new RetailersErrors.NotFound({ retailerId: error.retailerId }),
          ),
        ),
      )

  return { create, update, get, getForShare, list, impact, remove }
})

export const layerNoDeps = Layer.effect(Service, make)

export const layer = layerNoDeps.pipe(
  Layer.provide([RetailersRepo.layer, Cascade.layer]),
)

/** Accept a pasted URL or host, and store only its canonical domain. */
export const canonicalDomain = (
  input: string,
): Option.Option<Retailer.Domain> => {
  const trimmed = input.trim()

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  const url = URL.canParse(candidate) ? new URL(candidate) : undefined

  if (url === undefined) return Option.none()
  const host = url.hostname.toLowerCase().replace(/^www\./, "")

  // WHATWG expands IPv4 shorthand; the domain pattern alone also admits dotted numeric IPs.
  if (/^[0-9.]+$/.test(host)) return Option.none()

  return Schema.decodeUnknownOption(Retailer.Domain)(host)
}

const requireDomain = (input: string) =>
  Option.match(canonicalDomain(input), {
    onNone: () => Effect.fail(new RetailersErrors.InvalidDomain({ input })),
    onSome: Effect.succeed,
  })

/**
 * The host rule as a child write raises it: a Listing or Page URL must sit on
 * its Retailer's domain, and a write that would break that is refused rather
 * than flagged. The caller reads the Retailer row `FOR SHARE` first, so the
 * domain checked here is the domain the transaction will see committed. The
 * error names no rows: the one it refuses is the one about to be written,
 * and only a Retailer domain change (Retailers.ts) has stored rows to name.
 */
export const requireHostMatch = (
  url: string,
  domain: Retailer.Domain,
): Effect.Effect<void, RetailersErrors.UrlHostMismatch> =>
  Retailer.hostMatches(url, domain)
    ? Effect.void
    : Effect.fail(
        new RetailersErrors.UrlHostMismatch({
          url,
          domain,
          listingIds: [],
          pageIds: [],
        }),
      )
