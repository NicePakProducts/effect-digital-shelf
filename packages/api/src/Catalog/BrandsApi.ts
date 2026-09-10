import {
  CreateBrand,
  UpdateBrand,
} from "@digital-shelf/domain/Catalog/BrandManagement"
import { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Errors from "./Errors.ts"
import * as Wire from "./BrandsWire.ts"

export class BrandsApi extends HttpApiGroup.make("brands").add(
  HttpApiEndpoint.get("list", "/brands", { success: Wire.BrandList }),
  HttpApiEndpoint.get("get", "/brands/:id", {
    params: Wire.IdParams,
    success: Wire.BrandWire,
    error: [Errors.BrandNotFound],
  }),
  HttpApiEndpoint.post("create", "/brands", {
    payload: CreateBrand,
    success: Wire.BrandWire.pipe(HttpApiSchema.status(201)),
    error: [],
  }),
  HttpApiEndpoint.patch("update", "/brands/:id", {
    params: Wire.IdParams,
    payload: UpdateBrand,
    success: Wire.BrandWire,
    error: [Errors.BrandNotFound],
  }),
  HttpApiEndpoint.get("impact", "/brands/:id/impact", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.BrandNotFound],
  }),
  HttpApiEndpoint.delete("remove", "/brands/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.BrandNotFound],
  }),
) {}
