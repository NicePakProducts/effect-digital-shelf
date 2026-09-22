import { createFileRoute, redirect } from "@tanstack/react-router"
import { useState } from "react"
import { authActions } from "../lib/auth"
import { AuthActionError } from "@app/client/auth"
import { safeReturnPath, signInSearch } from "../lib/auth-navigation"
import {
  AuthFrame,
  AuthIcon,
  FocusHeading,
  SessionError,
  SessionLoading,
} from "../lib/AuthView"
import { useAuthAction } from "../lib/use-auth-action"

export const Route = createFileRoute("/sign-in")({
  validateSearch: signInSearch,
  beforeLoad: async ({ context, search }) => {
    const session = await context.auth.ready()

    if (session.error) throw new AuthActionError()

    if (session.data)
      throw redirect({ href: safeReturnPath(search.redirect), replace: true })
  },
  pendingComponent: SessionLoading,
  errorComponent: SessionError,
  component: SignIn,
})

function SignIn() {
  const search = Route.useSearch()
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(0)
  const [recovery, setRecovery] = useState(Boolean(search.error))
  const action = useAuthAction()

  const send = () =>
    void action.run(
      authActions.requestLink({ email, redirect: search.redirect }),
      () => setSent((count) => count + 1),
    )

  return (
    <AuthFrame>
      <title>Sign in · Digital Shelf</title>
      {recovery ? (
        <>
          <FocusHeading>
            {search.error === "invalid"
              ? "This sign-in link is no longer valid."
              : "We couldn’t verify this sign-in link."}
          </FocusHeading>
          <p>Request a fresh link to sign in.</p>
          <button onClick={() => setRecovery(false)}>Back to sign in</button>
        </>
      ) : sent ? (
        <>
          <FocusHeading>Check your inbox.</FocusHeading>
          <p>If this address is eligible, you’ll receive a sign-in link at:</p>
          <strong>{email.trim()}</strong>
          <p>
            Open the link to enter your workspace.
            <br />
            It’s valid for 15 minutes and can be used once.
          </p>
          {sent > 1 && (
            <p role="status">Another link requested. Check your inbox.</p>
          )}
          {action.failed && <SendFailure />}
          <button disabled={action.pending} onClick={send}>
            {action.pending ? "Sending…" : "Send another link"}
          </button>
          <button
            className="text-button"
            disabled={action.pending}
            onClick={() => {
              setSent(0)
              setEmail("")
            }}
          >
            ← Use a different email
          </button>
          <p className="fine-print">
            Nothing yet? Check your spam folder and make sure you used your work
            email.
          </p>
        </>
      ) : (
        <>
          <h1 className="entry-heading">WELCOME TO DIGITAL SHELF</h1>
          <p>Sign in with a link sent to your work email.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              send()
            }}
          >
            <div className="auth-email-input">
              <AuthIcon name="mail" />
              <input
                aria-label="Work email"
                name="email"
                type="email"
                required
                autoComplete="email"
                autoCapitalize="none"
                spellCheck={false}
                placeholder="you@npbrands.com.au"
                value={email}
                disabled={action.pending}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            {action.failed && <SendFailure />}
            <button type="submit" disabled={action.pending}>
              {action.pending ? "Sending…" : "Send sign-in link"}
              <AuthIcon name="arrow" />
            </button>
          </form>
          <p className="fine-print">
            <AuthIcon name="shield" />
            Use your @npbrands.com.au email.
            <br />
            First time here? Your work email is all you need.
          </p>
        </>
      )}
    </AuthFrame>
  )
}

function SendFailure() {
  return (
    <p role="alert">We couldn’t send your sign-in link. Please try again.</p>
  )
}
