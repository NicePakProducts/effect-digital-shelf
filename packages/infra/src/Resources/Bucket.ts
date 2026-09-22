import { Bucket, type BucketLifecycleRule } from "alchemy/Cloudflare/R2"
import * as RemovalPolicy from "alchemy/RemovalPolicy"
import { resourceName, type Stage } from "./Names"

/** ADR 0001: retention's 90 days plus a seven-day orphan backstop. */
export const lifecycleRules: BucketLifecycleRule[] = ["html/", "raw/"].map(
  (prefix) => ({
    id: `expire-${prefix.slice(0, -1)}`,
    enabled: true,
    prefix,
    deleteObjectsTransition: {
      condition: { type: "Age", maxAge: 97 * 24 * 60 * 60 },
    },
  }),
)

export const make = (stage: Stage) =>
  Bucket("Bucket", {
    name: resourceName(stage, "bucket"),
    lifecycleRules,
  }).pipe(RemovalPolicy.retain())
