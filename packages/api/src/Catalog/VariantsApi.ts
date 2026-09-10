import {
  CreateVariant,
  UpdateVariant,
} from "@digital-shelf/domain/Catalog/VariantManagement"
import { CascadeImpact } from "@digital-shelf/domain/Catalog/CascadeImpact"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema"
import * as Errors from "./Errors.ts"
import * as Wire from "./VariantsWire.ts"

export class VariantsApi extends HttpApiGroup.make("variants").add(
  HttpApiEndpoint.get("list", "/variants", {
    query: Wire.VariantsQuery,
    success: Wire.VariantList,
  }),
  HttpApiEndpoint.get("get", "/variants/:id", {
    params: Wire.IdParams,
    success: Wire.VariantWire,
    error: [Errors.VariantNotFound],
  }),
  HttpApiEndpoint.post("create", "/variants", {
    payload: CreateVariant,
    success: Wire.VariantWire.pipe(HttpApiSchema.status(201)),
    error: [Errors.ProductNotFound, Errors.DuplicateVariantName],
  }),
  HttpApiEndpoint.patch("update", "/variants/:id", {
    params: Wire.IdParams,
    payload: UpdateVariant,
    success: Wire.VariantWire,
    error: [Errors.VariantNotFound, Errors.DuplicateVariantName],
  }),
  HttpApiEndpoint.delete("remove", "/variants/:id", {
    params: Wire.IdParams,
    success: CascadeImpact,
    error: [Errors.VariantNotFound],
  }),
) {}
