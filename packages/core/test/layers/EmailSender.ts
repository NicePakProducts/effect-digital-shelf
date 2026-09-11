import {
  EmailSender,
  EmailSendFailed,
  type EmailMessage,
} from "@digital-shelf/core/Auth/EmailSender"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"

const make = Effect.gen(function* () {
  const messages = yield* Ref.make<ReadonlyArray<EmailMessage>>([])
  const failure = yield* Ref.make(false)

  const service: EmailSender["Service"] = {
    send: (message) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(failure, false))
          return yield* new EmailSendFailed({
            message: "Scripted email failure",
          })
        yield* Ref.update(messages, (sent) => [...sent, message])
      }),
  }

  return {
    service,
    sent: Ref.get(messages),
    clear: Effect.gen(function* () {
      yield* Ref.set(messages, [])
      yield* Ref.set(failure, false)
    }),
    fail: Ref.set(failure, true),
  }
})

export class EmailSenderTest extends Context.Service<
  EmailSenderTest,
  Effect.Success<typeof make>
>()("test/EmailSender", { make }) {}

export const layerTest = Layer.effect(
  EmailSender,
  Effect.map(EmailSenderTest, (test) => test.service),
).pipe(Layer.provideMerge(Layer.effect(EmailSenderTest, EmailSenderTest.make)))
