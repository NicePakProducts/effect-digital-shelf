import {
  CreateProduct,
  UpdateProduct,
} from "@digital-shelf/domain/Catalog/ProductManagement"
import { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Errors from "./Errors.ts"
import * as Wire from "./ProductsWire.ts"

export class ProductsApi extends HttpApiGroup.make("products").add(
  HttpApiEndpoint.get("list", "/products", {
    query: Wire.ProductsQuery,
    success: Wire.ProductList,
  }),
  HttpApiEndpoint.get("get", "/products/:id", {
    params: Wire.IdParams,
    success: Wire.ProductWire,
    error: [Errors.ProductNotFound],
  }),
  HttpApiEndpoint.post("create", "/products", {
    payload: CreateProduct,
    success: Wire.ProductWire.pipe(HttpApiSchema.status(201)),
    error: [Errors.BrandNotFound],
  }),
  HttpApiEndpoint.patch("update", "/products/:id", {
    params: Wire.IdParams,
    payload: UpdateProduct,
    success: Wire.ProductWire,
    error: [Errors.ProductNotFound],
  }),
  HttpApiEndpoint.get("impact", "/products/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.ProductNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/products/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.ProductNotFound],
  }),
) {}
