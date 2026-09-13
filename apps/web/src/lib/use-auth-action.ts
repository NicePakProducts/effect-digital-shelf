import { useRef, useState } from "react"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"

export function useAuthAction() {
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)

  const run = async (
    action: Effect.Effect<void, unknown>,
    onSuccess: () => void,
  ) => {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setFailed(false)
    const result = await Effect.runPromise(Effect.result(action))
    lock.current = false
    setPending(false)

    if (Result.isFailure(result)) return setFailed(true)
    onSuccess()
  }

  return { pending, failed, run }
}
