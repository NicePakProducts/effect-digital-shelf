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
  const retailer = yield* (yield* Retailers).create({
    name: "Shop",
    domain: `${crypto.randomUUID()}.example.com`,
  })
  return { brandId: brand.id, productId: product.id, retailerId: retailer.id }
})
