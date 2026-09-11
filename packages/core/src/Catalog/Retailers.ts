import {
  type RetailerNotFound,
  InvalidRetailerDomain,
  RetailerDomainTaken,
  UrlHostMismatch,
} from "@digital-shelf/domain/Catalog/Errors"
import type { Retailer } from "@digital-shelf/domain/Catalog/Retailer"
import type { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { CascadeRoot } from "./repositories/CascadeRepo.ts"
import {
  RetailerDomain,
  hostMatches,
} from "@digital-shelf/domain/Catalog/Retailer"
import {
  type CreateRetailer,
  type GetRetailerInput,
  type RemoveRetailerInput,
  type UpdateRetailerInput,
  type RetailerImpactInput,
  defaultScrapeMode,
  defaultScrapeCountry,
  defaultListingExtractPrompt,
  defaultPageExtractPrompt,
} from "@digital-shelf/domain/Catalog/RetailerManagement"
import type { RetailerId } from "@digital-shelf/domain/Shared/Ids"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { Db } from "../Sql/Db.ts"
import { Cascade } from "./Cascade.ts"
import { ListingsRepo } from "./repositories/ListingsRepo.ts"
import { PagesRepo } from "./repositories/PagesRepo.ts"
import { RetailersRepo } from "./repositories/RetailersRepo.ts"

export class Retailers extends Context.Service<
  Retailers,
  {
    readonly create: (
      command: CreateRetailer,
    ) => Effect.Effect<
      Retailer,
      InvalidRetailerDomain | RetailerDomainTaken | SqlError
    >
    readonly update: (
      input: UpdateRetailerInput,
    ) => Effect.Effect<
      Retailer,
      | RetailerNotFound
      | InvalidRetailerDomain
      | RetailerDomainTaken
      | UrlHostMismatch
      | SqlError
    >
    readonly get: (
      input: GetRetailerInput,
    ) => Effect.Effect<Retailer, RetailerNotFound | SqlError>
    readonly list: Effect.Effect<ReadonlyArray<Retailer>, SqlError>
    readonly remove: (
      input: RemoveRetailerInput,
    ) => Effect.Effect<CascadeImpact, RetailerNotFound | SqlError>
    readonly impact: (
      input: RetailerImpactInput,
    ) => Effect.Effect<CascadeImpact, RetailerNotFound | SqlError>
  }
>()("@digital-shelf/core/Catalog/Retailers", {
  make: Effect.gen(function* () {
    const db = yield* Db
    const cascade = yield* Cascade
    const repo = yield* RetailersRepo
    const listingsRepo = yield* ListingsRepo
    const pagesRepo = yield* PagesRepo

    /**
     * Every child URL that the new domain would leave stranded. The Retailer row
     * is already locked `FOR UPDATE` when this runs, so no concurrent child write
     * can add one behind it.
     */
    const refuseStrandedChildren = Effect.fn(
      "Retailers.refuseStrandedChildren",
    )(function* (id: RetailerId, domain: RetailerDomain) {
      const listings = (yield* listingsRepo.list({ retailerId: id })).filter(
        (row) => !hostMatches(row.url, domain),
      )

      const pages = (yield* pagesRepo.list({ retailerId: id })).filter(
        (row) => !hostMatches(row.url, domain),
      )

      const first = listings[0] ?? pages[0]

      if (first === undefined) return

      return yield* Effect.fail(
        new UrlHostMismatch({
          url: first.url,
          domain,
          listingIds: listings.map((row) => row.id),
          pageIds: pages.map((row) => row.id),
        }),
      )
    })

    const taken = (domain: RetailerDomain) =>
      Effect.gen(function* () {
        const holder = yield* repo.findByDomain(domain)

        if (Option.isNone(holder))
          return yield* Effect.die(
            new Error(
              "Conflicting Retailer disappeared before its domain could be identified",
            ),
          )

        return yield* Effect.fail(
          new RetailerDomainTaken({ domain, retailerId: holder.value.id }),
        )
      })

    const create = Effect.fn("Retailers.create")(function* (
      command: CreateRetailer,
    ) {
      const domain = yield* requireDomain(command.domain)

      const insert = db.transaction(() =>
        repo.insert({
          ...command,
          domain,
          paused: command.paused ?? false,
          scrapeMode: command.scrapeMode ?? defaultScrapeMode,
          scrapeCountry: command.scrapeCountry ?? defaultScrapeCountry,
          listingExtractPrompt:
            command.listingExtractPrompt ?? defaultListingExtractPrompt,
          pageExtractPrompt:
            command.pageExtractPrompt ?? defaultPageExtractPrompt,
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
              new RetailerDomainTaken({ domain, retailerId: holder.value.id }),
            )
          }),
        ),
      )
    })

    const update = Effect.fn("Retailers.update")(function* (
      input: UpdateRetailerInput,
    ) {
      const { domain: domainInput, ...patch } = input.command

      const domain =
        domainInput === undefined
          ? undefined
          : yield* requireDomain(domainInput)

      return yield* db
        .transaction(() =>
          Effect.gen(function* () {
            if (domain !== undefined) {
              // The lock excludes child writes until this transaction commits,
              // so a Listing or Page cannot slip past the check below on the
              // old domain and land under the new one.
              yield* repo.getForUpdate(input.retailerId)
              yield* refuseStrandedChildren(input.retailerId, domain)
            }

            return yield* repo.update(
              input.retailerId,
              domain === undefined ? patch : { ...patch, domain },
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

    const get = Effect.fn("Retailers.get")(function* (input: GetRetailerInput) {
      return yield* repo.get(input.retailerId)
    })

    const list = repo.list.pipe(Effect.withSpan("Retailers.list"))

    const impact = Effect.fn("Retailers.impact")(function* (
      input: RetailerImpactInput,
    ) {
      yield* repo.get(input.retailerId)

      return yield* cascade.impact(
        CascadeRoot.Retailer({ id: input.retailerId }),
      )
    })

    const remove = Effect.fn("Retailers.remove")(function* (
      input: RemoveRetailerInput,
    ) {
      return (yield* cascade.remove(
        CascadeRoot.Retailer({ id: input.retailerId }),
        repo.remove(input.retailerId),
      )).impact
    })

    return { create, update, get, list, impact, remove }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([RetailersRepo.layer, ListingsRepo.layer, PagesRepo.layer]),
  )
}

/** Accept a pasted URL or host, and store only its canonical domain. */
export const canonicalDomain = (
  input: string,
): Option.Option<RetailerDomain> => {
  const trimmed = input.trim()

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  const url = URL.canParse(candidate) ? new URL(candidate) : undefined

  if (url === undefined) return Option.none()
  const host = url.hostname.toLowerCase().replace(/^www\./, "")

  // WHATWG expands IPv4 shorthand; the domain pattern alone also admits dotted numeric IPs.
  if (/^[0-9.]+$/.test(host)) return Option.none()

  return Schema.decodeUnknownOption(RetailerDomain)(host)
}

const requireDomain = (input: string) =>
  Option.match(canonicalDomain(input), {
    onNone: () => Effect.fail(new InvalidRetailerDomain({ input })),
    onSome: Effect.succeed,
  })
