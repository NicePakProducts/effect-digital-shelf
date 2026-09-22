import { Product } from "@app/schema/product"
import * as Schema from "effect/Schema"
import { ProductNotFound } from "./products"
import { ProductVariant } from "@app/schema/product-variant"
import { CascadeImpact } from "@app/schema/cascade"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./product-variant-wire"

export class VariantNotFound extends Schema.TaggedError<VariantNotFound>()(
  "VariantNotFound",
  { variantId: ProductVariant.Id },
  { httpApiStatus: 404 },
) {}

export class DuplicateVariantName extends Schema.TaggedError<DuplicateVariantName>()(
  "DuplicateVariantName",
  { productId: Product.Id, name: Schema.String },
  { httpApiStatus: 409 },
) {}

export class ProductVariantsApi extends HttpApiGroup.make("variants").add(
  HttpApiEndpoint.get("list", "/variants", {
    query: Wire.VariantsQuery,
    success: Wire.VariantList,
  }),
  HttpApiEndpoint.get("get", "/variants/:id", {
    params: Wire.IdParams,
    success: Wire.VariantWire,
    error: [VariantNotFound],
  }),
  HttpApiEndpoint.post("create", "/variants", {
    payload: ProductVariant.Create,
    success: Wire.VariantWire.pipe(HttpApiSchema.status(201)),
    error: [ProductNotFound, DuplicateVariantName],
  }),
  HttpApiEndpoint.patch("update", "/variants/:id", {
    params: Wire.IdParams,
    payload: ProductVariant.Update,
    success: Wire.VariantWire,
    error: [VariantNotFound, DuplicateVariantName],
  }),
  HttpApiEndpoint.delete("remove", "/variants/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [VariantNotFound],
  }),
) {}
