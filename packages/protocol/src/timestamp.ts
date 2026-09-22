import * as Schema from "effect/Schema"
import * as SchemaTransformation from "effect/SchemaTransformation"

/** ISO strings on the wire, UTC date-time values inside the application. */
export const TimestampWire = Schema.String.annotate({
  format: "date-time",
}).pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.dateTimeUtcFromString,
  ),
)
