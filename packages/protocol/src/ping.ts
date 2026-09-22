import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint"
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup"
import { TimestampWire } from "./timestamp"

export class PingApi extends HttpApiGroup.make("ping").add(
  HttpApiEndpoint.get("get", "/ping", {
    success: Schema.Struct({
      message: Schema.Literal("pong"),
      timestamp: TimestampWire,
    }),
  }),
) {}
