import * as Layers from "@digital-shelf/core/Layers"
import * as Layer from "effect/Layer"
import * as DbTest from "./Db.ts"

/** Every entrypoint layer over the test database and the fakes. */
export const layerTest = Layers.Catalog.pipe(
  Layer.provideMerge(DbTest.layerTest),
)
