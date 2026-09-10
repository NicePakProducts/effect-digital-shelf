import { Brands } from "@digital-shelf/core/Catalog/Brands"
import { Products } from "@digital-shelf/core/Catalog/Products"
import { Retailers } from "@digital-shelf/core/Catalog/Retailers"
import * as Effect from "effect/Effect"

export const seed = Effect.fn("CatalogFixture.seed")(function* () {
  const brand = yield* (yield* Brands).create({ name: "Gaia" })
  const product = yield* (yield* Products).create({
    brandId: brand.id,
    name: "Wash",
  })
  const domain = `${crypto.randomUUID()}.example.com`
  const retailer = yield* (yield* Retailers).create({ name: "Shop", domain })
  return {
    brandId: brand.id,
    productId: product.id,
    retailerId: retailer.id,
    domain: retailer.domain,
    /** A URL on the seeded Retailer's domain, which the host rule requires. */
    url: (path = "") => `https://${retailer.domain}${path}`,
  }
})
