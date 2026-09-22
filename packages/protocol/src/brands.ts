import * as Schema from "effect/Schema"
import { BrandId } from "@app/schema/ids"
import { Brand } from "@app/schema/brand"
import { CascadeImpact } from "@app/schema/cascade"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Wire from "./brand-wire"

export class BrandNotFound extends Schema.TaggedError<BrandNotFound>()(
  "BrandNotFound",
  { brandId: BrandId },
  { httpApiStatus: 404 },
) {}

export class BrandsApi extends HttpApiGroup.make("brands").add(
  HttpApiEndpoint.get("list", "/brands", { success: Wire.BrandList }),
  HttpApiEndpoint.get("get", "/brands/:id", {
    params: Wire.IdParams,
    success: Wire.BrandWire,
    error: [BrandNotFound],
  }),
  HttpApiEndpoint.post("create", "/brands", {
    payload: Brand.Create,
    success: Wire.BrandWire.pipe(HttpApiSchema.status(201)),
    error: [],
  }),
  HttpApiEndpoint.patch("update", "/brands/:id", {
    params: Wire.IdParams,
    payload: Brand.Update,
    success: Wire.BrandWire,
    error: [BrandNotFound],
  }),
  HttpApiEndpoint.get("impact", "/brands/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [BrandNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/brands/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [BrandNotFound],
  }),
) {}
