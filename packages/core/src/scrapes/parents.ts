import { ListingsErrors, Listings } from "../listings"
import { PagesErrors, Pages } from "../pages"
import * as Option from "effect/Option"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Predicate from "effect/Predicate"
import type * as DateTime from "effect/DateTime"
import type { Scrape } from "@app/schema/scrape"
import { Brands } from "../brands"
import { Products } from "../products"
import { Retailers } from "../retailers"
import { ParentsRepo } from "./parents/repository"

export * as Parents from "./parents"

const make = Effect.gen(function* () {
  const repo = yield* ParentsRepo.Service
  const brands = yield* Brands.Service
  const products = yield* Products.Service
  const retailers = yield* Retailers.Service
  const listings = yield* Listings.Service
  const pages = yield* Pages.Service

  const getTarget = Effect.fn("Parents.getTarget", { level: "Debug" })(
    function* (parent: Scrape.Parent) {
      const target = yield* repo.findTarget(parent)

      if (Option.isSome(target)) return target.value

      return yield* Effect.fail(
        Predicate.isTagged(parent, "Listing")
          ? new ListingsErrors.NotFound({ listingId: parent.listingId })
          : new PagesErrors.NotFound({ pageId: parent.pageId }),
      )
    },
  )

  const containerExists = (scope: Scrape.Bulk) =>
    Match.value(scope).pipe(
      Match.tag("Brand", (input) =>
        brands.get({ brandId: input.brandId }).pipe(
          Effect.as(true),
          Effect.catchTag("BrandNotFound", () => Effect.succeed(false)),
        ),
      ),
      Match.tag("Product", (input) =>
        products.get({ productId: input.productId }).pipe(
          Effect.as(true),
          Effect.catchTag("ProductNotFound", () => Effect.succeed(false)),
        ),
      ),
      Match.tag("Retailer", (input) =>
        retailers.get({ retailerId: input.retailerId }).pipe(
          Effect.as(true),
          Effect.catchTag("RetailerNotFound", () => Effect.succeed(false)),
        ),
      ),
      Match.exhaustive,
    )

  const markScraped = (parent: Scrape.Parent, at: DateTime.Utc) =>
    Predicate.isTagged(parent, "Listing")
      ? listings.markScraped({ listingId: parent.listingId, at })
      : pages.markScraped({ pageId: parent.pageId, at })

  return {
    findTarget: repo.findTarget,
    getTarget,
    cadenceDue: repo.cadenceDue,
    bulkCandidates: repo.bulkCandidates,
    containerExists,
    markScraped,
  }
})

export interface Interface extends Effect.Success<typeof make> {}

export class Service extends Context.Service<Service, Interface>()(
  "@app/core/scrapes/parents",
) {}

export const layer = Layer.effect(Service, make).pipe(
  Layer.provide([
    ParentsRepo.layer,
    Brands.layer,
    Products.layer,
    Retailers.layer,
    Listings.layer,
    Pages.layer,
  ]),
)
