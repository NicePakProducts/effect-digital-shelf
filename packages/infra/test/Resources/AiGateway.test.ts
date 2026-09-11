import { describe, expect, it } from "@effect/vitest"
import { otelOf } from "@digital-shelf/infra/Resources/AiGateway"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"

describe("AI Gateway telemetry", () => {
  it("declares the protobuf trace exporter with authorization inside headers", () => {
    expect(
      otelOf(
        Option.some({
          domain: "example.test",
          token: Redacted.make("test-token"),
        }),
      ),
    ).toEqual([
      {
        url: "https://example.test/v1/traces",
        headers: {
          Authorization: "Bearer test-token",
          "X-Axiom-Dataset": "digital-shelf-traces",
        },
        contentType: "protobuf",
      },
    ])
  })

  it("explicitly clears exporters when Axiom is absent", () => {
    expect(otelOf(Option.none())).toEqual([])
  })
})
