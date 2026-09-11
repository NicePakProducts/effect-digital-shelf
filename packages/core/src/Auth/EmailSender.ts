import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"

export interface EmailMessage {
  readonly to: string
  readonly subject: string
  readonly text: string
}

export class EmailSendFailed extends Schema.TaggedError<EmailSendFailed>()(
  "EmailSendFailed",
  { message: Schema.String },
) {}

export class EmailSender extends Context.Service<
  EmailSender,
  {
    readonly send: (
      message: EmailMessage,
    ) => Effect.Effect<void, EmailSendFailed>
  }
>()("@digital-shelf/core/Auth/EmailSender") {
  static readonly layerPostmark = Layer.effect(
    this,
    Effect.gen(function* () {
      const token = yield* Config.redacted("POSTMARK_SERVER_TOKEN")
      const from = yield* Config.string("POSTMARK_FROM")

      const stream = yield* Config.string("POSTMARK_MESSAGE_STREAM").pipe(
        Config.withDefault("outbound"),
      )

      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)

      const send = Effect.fn("EmailSender.send")(
        function* (message: EmailMessage) {
          const request = yield* HttpClientRequest.post(
            "https://api.postmarkapp.com/email",
          ).pipe(
            HttpClientRequest.setHeaders({
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-Postmark-Server-Token": Redacted.value(token),
            }),
            HttpClientRequest.bodyJson({
              From: from,
              To: message.to,
              Subject: message.subject,
              TextBody: message.text,
              MessageStream: stream,
            }),
          )

          const response = yield* client.execute(request)
          yield* response.json
        },
        // Drop the cause: HttpClientError contains the request and its secret token header.
        Effect.mapError(
          () =>
            new EmailSendFailed({
              message: "Postmark could not send the email.",
            }),
        ),
      )

      return { send }
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer))
}
