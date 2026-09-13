import { useAtomValue } from "@effect/atom-react"
import { useRouter } from "@tanstack/react-router"
import { useEffect, useRef, type ReactNode } from "react"
import { authClient, authSession } from "./auth"
import "./auth.css"

export function AuthFrame(props: { readonly children: ReactNode }) {
  return (
    <div className="auth-page">
      <header>
        <div className="auth-logo">
          <span className="auth-logo-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            digital shelf<span className="auth-logo-period">.</span>
          </span>
        </div>
        <p>NICE PAK BRANDS / TEAM ACCESS</p>
      </header>
      <main>{props.children}</main>
    </div>
  )
}

export function AuthIcon(props: {
  readonly name: "mail" | "arrow" | "shield"
}) {
  const paths = {
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 6 9 7 9-7" />
      </>
    ),
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
  }

  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[props.name]}
    </svg>
  )
}

export function SessionLoading() {
  return (
    <AuthFrame>
      <p role="status">Checking your session…</p>
    </AuthFrame>
  )
}

export function SessionError() {
  const session = useAtomValue(authSession)
  const router = useRouter()

  return (
    <AuthFrame>
      <h1>We couldn’t check your session.</h1>
      <p role="alert">Your connection may be unavailable. Please try again.</p>
      <button
        disabled={session.isRefetching}
        onClick={() =>
          void authClient.useSession
            .get()
            .refetch()
            .then(() => router.invalidate())
        }
      >
        {session.isRefetching ? "Checking…" : "Try again"}
      </button>
    </AuthFrame>
  )
}

export function FocusHeading(props: { readonly children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [props.children])

  return (
    <h1 ref={heading} tabIndex={-1}>
      {props.children}
    </h1>
  )
}
