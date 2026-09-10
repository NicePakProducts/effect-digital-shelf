import { RetailerDomain } from "@digital-shelf/domain/Catalog/Retailer"
import {
  InvalidRetailerDomain,
  RetailerDomainTaken,
} from "@digital-shelf/domain/Catalog/Errors"
import {
  type CreateRetailer,
  type UpdateRetailer,
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
import * as Repo from "./repositories/RetailersRepo.ts"

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
const make = Effect.gen(function* () {
  const db = yield* Db
  const withDb = Effect.provideService(Db, db)
  const cascade = yield* Cascade
  const taken = (domain: RetailerDomain) =>
    Effect.gen(function* () {
      const holder = yield* Repo.findByDomain(domain)
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
      Repo.insert({
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
          const holder = yield* Repo.findByDomain(domain)
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
  }, withDb)
  const update = Effect.fn("Retailers.update")(function* (
    id: RetailerId,
    command: UpdateRetailer,
  ) {
    const { domain: input, ...patch } = command
    const domain = input === undefined ? undefined : yield* requireDomain(input)
    return yield* db
      .transaction(() => {
        // #38 adds the FOR UPDATE lock and the child URL host check here.
        return Repo.update(id, {
          ...patch,
          ...(domain === undefined ? {} : { domain }),
        })
      })
      .pipe(
        Effect.catchTag("DomainTaken", () =>
          domain === undefined
            ? Effect.die(new Error("Domain conflict without a domain change"))
            : taken(domain),
        ),
      )
  }, withDb)
  const get = Effect.fn("Retailers.get")(function* (id: RetailerId) {
    return yield* Repo.get(id)
  }, withDb)
  const list = Effect.fn("Retailers.list")(function* () {
    return yield* Repo.list()
  }, withDb)
  const impact = Effect.fn("Retailers.impact")(function* (id: RetailerId) {
    yield* Repo.get(id)
    return yield* cascade.impact({ _tag: "Retailer", id })
  }, withDb)
  const remove = Effect.fn("Retailers.remove")(function* (id: RetailerId) {
    return (yield* cascade.remove({ _tag: "Retailer", id }, Repo.remove(id)))
      .impact
  }, withDb)
  return { create, update, get, list, impact, remove }
})
export class Retailers extends Context.Service<
  Retailers,
  Effect.Success<typeof make>
>()("@digital-shelf/core/Catalog/Retailers", { make }) {
  static readonly layer = Layer.effect(this, this.make)
}
