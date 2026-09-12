import * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as OpenApi from "effect/unstable/httpapi/OpenApi"
import { CurrentUserMiddleware } from "./Auth/Security.ts"
import { BrandsApi } from "./Catalog/BrandsApi.ts"
import { ProductsApi } from "./Catalog/ProductsApi.ts"
import { VariantsApi } from "./Catalog/VariantsApi.ts"
import { RetailersApi } from "./Catalog/RetailersApi.ts"
import { ListingsApi } from "./Catalog/ListingsApi.ts"
import { PagesApi } from "./Catalog/PagesApi.ts"
import { ScrapesApi } from "./Scraping/ScrapesApi.ts"
import { ExtractionsApi } from "./Scraping/ExtractionsApi.ts"
import { PingApi } from "./PingApi.ts"

export class RootApi extends HttpApi.make("RootApi")
  .add(BrandsApi)
  .add(ProductsApi)
  .add(VariantsApi)
  .add(RetailersApi)
  .add(ListingsApi)
  .add(PagesApi)
  .add(ScrapesApi)
  .add(ExtractionsApi)
  // Middleware applies only to groups already added; ping is public.
  .middleware(CurrentUserMiddleware)
  .add(PingApi)
  .prefix("/api/v1")
  .annotate(OpenApi.Title, "Digital Shelf")
  .annotate(OpenApi.Version, "1")
  .annotate(
    OpenApi.Description,
    "Every operation except GET /api/v1/ping requires a Better Auth session cookie.",
  ) {}
