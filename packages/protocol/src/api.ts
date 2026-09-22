import * as HttpApi from "effect/unstable/httpapi/HttpApi"
import * as OpenApi from "effect/unstable/httpapi/OpenApi"
import { CurrentUserMiddleware } from "./auth/security"
import { BrandsApi } from "./brands"
import { ProductsApi } from "./products"
import { ProductVariantsApi } from "./product-variants"
import { RetailersApi } from "./retailers"
import { ListingsApi } from "./listings"
import { PagesApi } from "./pages"
import { ScrapesApi } from "./scrapes"
import { ExtractionsApi } from "./extractions"
import { PingApi } from "./ping"

export class Api extends HttpApi.make("RootApi")
  .add(BrandsApi)
  .add(ProductsApi)
  .add(ProductVariantsApi)
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
