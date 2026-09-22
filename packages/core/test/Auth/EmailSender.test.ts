import * as Result from "effect/Result"
import { expect, it } from "@effect/vitest"
import { EmailSender } from "@app/core/auth/email-sender"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

const ConfigurationLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    POSTMARK_SERVER_TOKEN: "test-postmark-token",
    POSTMARK_FROM: "shelf@npbrands.com.au",
  }),
)

it.effect(
  "Postmark sends the configured JSON and maps rejected responses without leaking its token",
  () =>
    Effect.gen(function* () {
      const calls: Request[] = []

      const fetch: typeof globalThis.fetch = async (input, init) => {
        calls.push(new Request(input, init))

        return new Response("{}", {
          status: calls.length === 1 ? 200 : 422,
          headers: { "content-type": "application/json" },
        })
      }

      const program = Effect.gen(function* () {
        const emails = yield* EmailSender.Service
        yield* emails.send({
          to: "person@npbrands.com.au",
          subject: "Sign in",
          text: "https://shelf.test/link",
        })
        const request = calls[0]!
        expect(request.url).toBe("https://api.postmarkapp.com/email")
        expect(request.method).toBe("POST")
        expect(request.headers.get("X-Postmark-Server-Token")).toBe(
          "test-postmark-token",
        )
        const body = yield* Effect.promise(() => request.text())
        expect(
          yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Unknown),
          )(body),
        ).toEqual({
          From: "shelf@npbrands.com.au",
          To: "person@npbrands.com.au",
          Subject: "Sign in",
          TextBody: "https://shelf.test/link",
          MessageStream: "outbound",
        })

        const result = yield* emails
          .send({
            to: "person@npbrands.com.au",
            subject: "Sign in",
            text: "link",
          })
          .pipe(Effect.result)

        expect(result._tag).toBe("Failure")

        if (Result.isFailure(result)) {
          expect(result.failure._tag).toBe("EmailSendFailed")
          expect(result.failure.message).not.toContain("test-postmark-token")
        }
      })

      yield* program.pipe(
        Effect.provide(
          EmailSender.layer.pipe(Layer.provide(ConfigurationLayer)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      )
    }),
)
