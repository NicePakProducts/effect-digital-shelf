import { BrandNotFound } from "./brands"
import * as Schema from "effect/Schema"
import { Product } from "@app/schema/product"
import { CascadeImpact } from "@app/schema/cascade"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./product-wire"

export class ProductNotFound extends Schema.TaggedError<ProductNotFound>()(
  "ProductNotFound",
  { productId: Product.Id },
  { httpApiStatus: 404 },
) {}

export class ProductsApi extends HttpApiGroup.make("products").add(
  HttpApiEndpoint.get("list", "/products", {
    query: Wire.ProductsQuery,
    success: Wire.ProductList,
  }),
  HttpApiEndpoint.get("get", "/products/:id", {
    params: Wire.IdParams,
    success: Wire.ProductWire,
    error: [ProductNotFound],
  }),
  HttpApiEndpoint.post("create", "/products", {
    payload: Product.Create,
    success: Wire.ProductWire.pipe(HttpApiSchema.status(201)),
    error: [BrandNotFound],
  }),
  HttpApiEndpoint.patch("update", "/products/:id", {
    params: Wire.IdParams,
    payload: Product.Update,
    success: Wire.ProductWire,
    error: [ProductNotFound],
  }),
  HttpApiEndpoint.get("impact", "/products/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [ProductNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/products/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [ProductNotFound],
  }),
) {}
