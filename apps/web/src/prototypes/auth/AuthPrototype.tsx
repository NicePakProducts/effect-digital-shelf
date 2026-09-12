// THROWAWAY: three auth layouts at /prototype/auth?variant=A|B|C.
// Question: which entry experience feels right before wiring real magic-link auth?
import { useAtom } from "@effect/atom-react"
import * as Atom from "effect/unstable/reactivity/Atom"
import { useEffect, useRef, type ReactNode } from "react"
import { PrototypeSwitcher, type PrototypeVariant } from "../PrototypeSwitcher"
import "./auth-prototype.css"

type Flow =
  | {
      readonly step: "email"
      readonly sendFailed: boolean
      readonly signedOut: boolean
    }
  | {
      readonly step: "inbox"
      readonly sendFailed: boolean
      readonly eligible: boolean
    }
  | { readonly step: "expired" | "used" }
  | { readonly step: "signed-in" }

interface DemoState {
  readonly email: string
  readonly flow: Flow
  readonly sendAttempts: number
  readonly failNextSend: boolean
}

const initialState: DemoState = {
  email: "",
  flow: { step: "email", sendFailed: false, signedOut: false },
  sendAttempts: 0,
  failNextSend: false,
}

const demoAtom = Atom.make<DemoState>(initialState)

interface AuthPrototypeProps {
  readonly variant: PrototypeVariant
  readonly onVariantChange: (variant: PrototypeVariant) => void
}

export function AuthPrototype(props: AuthPrototypeProps) {
  const [demo, setDemo] = useAtom(demoAtom)
  const signedIn = demo.flow.step === "signed-in"
  const canOpenLink = demo.flow.step === "inbox" && demo.flow.eligible

  const sendLink = () =>
    setDemo((current) => {
      if (current.flow.step !== "email" && current.flow.step !== "inbox")
        return current

      return {
        ...current,
        email: current.email.trim(),
        sendAttempts: current.sendAttempts + 1,
        failNextSend: false,
        flow: current.failNextSend
          ? { ...current.flow, sendFailed: true }
          : {
              step: "inbox",
              sendFailed: false,
              eligible: current.email
                .trim()
                .toLowerCase()
                .endsWith("@npbrands.com.au"),
            },
      }
    })

  const returnToEmail = () =>
    setDemo((current) => ({
      ...current,
      flow: { step: "email", sendFailed: false, signedOut: false },
    }))

  const openLink = (step: "signed-in" | "expired" | "used") => {
    if (!canOpenLink) return
    setDemo((current) => ({ ...current, flow: { step } }))
  }

  const signOut = () =>
    setDemo({
      ...initialState,
      flow: { step: "email", sendFailed: false, signedOut: true },
    })

  const auth = (
    <AuthScreen
      demo={demo}
      onEmailChange={(email) => setDemo((current) => ({ ...current, email }))}
      onSend={sendLink}
      onReturn={returnToEmail}
    />
  )

  return (
    <div className={`auth-prototype auth-variant-${props.variant}`}>
      <title>Digital Shelf · Auth prototype</title>
      <aside className="proto-tools" aria-label="Prototype tools">
        <div className="proto-notice">
          <span>
            <span className="proto-dot" /> INTERACTIVE PROTOTYPE
          </span>
          <span>No real emails or sessions. Refresh to reset.</span>
        </div>
        <details className="proto-controls">
          <summary>
            <Icon name="sliders" /> Prototype controls{" "}
            <span className="proto-control-indicator" />
          </summary>
          <div className="proto-controls-body">
            <div className="proto-controls-heading">
              <strong>Try the whole journey</strong>
              <span>SIMULATION ONLY</span>
            </div>
            <p>
              Enter an @npbrands.com.au email, request a link, then open it
              here. Nothing is sent.
            </p>
            <button
              className="proto-control-button"
              type="button"
              disabled={demo.flow.step !== "email"}
              onClick={() =>
                setDemo((current) => ({
                  ...current,
                  email: "alex@npbrands.com.au",
                }))
              }
            >
              Use sample email
            </button>
            <div className="proto-control-divider" />
            <button
              className="proto-control-button proto-control-primary"
              type="button"
              disabled={!canOpenLink}
              onClick={() => openLink("signed-in")}
            >
              <Icon name="mail" /> Open simulated magic link <span>↗</span>
            </button>
            <div className="proto-control-pair">
              <button
                className="proto-control-button"
                type="button"
                disabled={!canOpenLink}
                onClick={() => openLink("expired")}
              >
                Open expired link
              </button>
              <button
                className="proto-control-button"
                type="button"
                disabled={!canOpenLink}
                onClick={() => openLink("used")}
              >
                Open used link
              </button>
            </div>
            {demo.flow.step === "inbox" && !demo.flow.eligible && (
              <p className="proto-control-note">
                This demo only delivers links to npbrands.com.au. The public
                confirmation stays generic, as in the backend.
              </p>
            )}
            <button
              className="proto-control-button"
              type="button"
              aria-pressed={demo.failNextSend}
              disabled={signedIn}
              onClick={() =>
                setDemo((current) => ({
                  ...current,
                  failNextSend: !current.failNextSend,
                }))
              }
            >
              <span
                className={`proto-toggle ${demo.failNextSend ? "is-on" : ""}`}
              />{" "}
              Fail next email request{" "}
              <span>{demo.failNextSend ? "ON" : "OFF"}</span>
            </button>
            <button
              className="proto-control-button"
              type="button"
              onClick={() => setDemo(initialState)}
            >
              <Icon name="reset" /> Reset demo
            </button>
            <div className="proto-state-heading">
              LIVE STATE <span>memory only</span>
            </div>
            <pre data-testid="prototype-state">
              {JSON.stringify(
                {
                  variant: props.variant,
                  ...demo,
                  session: signedIn ? { email: demo.email } : null,
                  network: "disabled",
                },
                null,
                2,
              )}
            </pre>
          </div>
        </details>
      </aside>

      {signedIn ? (
        <Workspace email={demo.email} onSignOut={signOut} />
      ) : props.variant === "A" ? (
        <VariantA>{auth}</VariantA>
      ) : props.variant === "B" ? (
        <VariantB>{auth}</VariantB>
      ) : (
        <VariantC>{auth}</VariantC>
      )}

      <PrototypeSwitcher
        variant={props.variant}
        onChange={props.onVariantChange}
      />
    </div>
  )
}

export function VariantA(props: { readonly children: ReactNode }) {
  return (
    <div className="focused-layout">
      <header className="auth-header">
        <Wordmark />
        <span className="header-meta">A workspace for your digital shelf</span>
      </header>
      <main className="focused-main">
        <div className="focused-intro">
          <span className="eyebrow">NICE PAK BRANDS</span>
          <p>
            A clearer view.
            <br />
            One place to begin.
          </p>
        </div>
        <div className="focused-card">{props.children}</div>
        <p className="auth-security">
          <Icon name="lock" /> Your work email is your key. No password needed.
        </p>
      </main>
      <footer className="auth-footer">
        <span>Digital Shelf / Nice Pak Brands</span>
        <span>Made for the everyday details.</span>
      </footer>
    </div>
  )
}

export function VariantB(props: { readonly children: ReactNode }) {
  return (
    <div className="minimal-layout">
      <header>
        <Wordmark />
        <span className="header-meta">NICE PAK BRANDS / TEAM ACCESS</span>
      </header>
      <main>
        {props.children}
        <p className="auth-security">
          <Icon name="lock" /> Secure access, without another password.
        </p>
      </main>
      <footer>One shared workspace for the team.</footer>
    </div>
  )
}

export function VariantC(props: { readonly children: ReactNode }) {
  return (
    <div className="app-layout">
      <Sidebar signedIn={false} />
      <div className="app-main">
        <header className="app-topbar">
          <span>
            Workspace <span className="breadcrumb-separator">/</span> Overview
          </span>
          <span className="session-label">
            <Icon name="lock" /> Signed out
          </span>
        </header>
        <main className="app-entry">
          <div className="app-entry-context">
            <span className="eyebrow">YOUR SHARED WORKSPACE</span>
            <h2>Everything starts here.</h2>
            <p>
              Sign in to work with your catalog,
              <br />
              Scrapes and Extractions.
            </p>
            <div className="workspace-outline" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="app-entry-card">{props.children}</div>
        </main>
        <footer className="app-footer">
          <Icon name="lock" /> Catalog data is only available after sign-in.
        </footer>
      </div>
    </div>
  )
}

interface AuthScreenProps {
  readonly demo: DemoState
  readonly onEmailChange: (email: string) => void
  readonly onSend: () => void
  readonly onReturn: () => void
}

function AuthScreen(props: AuthScreenProps) {
  const flow = props.demo.flow
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [flow.step])

  if (flow.step === "email")
    return (
      <section className="auth-screen" aria-labelledby="auth-heading">
        <div className="auth-symbol">
          <Icon name="arrow" />
        </div>
        <span className="eyebrow">WELCOME TO DIGITAL SHELF</span>
        <h1 id="auth-heading" tabIndex={-1} ref={heading}>
          Good to have you here.
        </h1>
        <p className="auth-description">
          Sign in with a link sent to your work email.
          <br />
          No password to remember.
        </p>
        {flow.signedOut && (
          <p className="auth-success" role="status">
            <Icon name="check" /> You’ve signed out. See you next time.
          </p>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault()
            props.onSend()
          }}
        >
          <label htmlFor="work-email">Work email</label>
          <div className="auth-input-wrap">
            <Icon name="mail" />
            <input
              id="work-email"
              name="email"
              type="email"
              required
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@npbrands.com.au"
              value={props.demo.email}
              onChange={(event) => props.onEmailChange(event.target.value)}
              aria-describedby="email-hint"
            />
          </div>
          <p id="email-hint" className="auth-field-hint">
            For the Nice Pak Brands team.
          </p>
          {flow.sendFailed && <SendFailure />}
          <button className="auth-primary" type="submit">
            {flow.sendFailed ? "Try sending again" : "Send sign-in link"}
            <Icon name="arrow" />
          </button>
        </form>
        <div className="auth-fine-print">
          <Icon name="shield" />
          <p>
            Use your @npbrands.com.au email.
            <br />
            First time here? Your work email is all you need.
          </p>
        </div>
      </section>
    )

  if (flow.step === "inbox")
    return (
      <section className="auth-screen" aria-labelledby="auth-heading">
        <div className="auth-symbol">
          <Icon name="mail" />
        </div>
        <span className="eyebrow">ONE MORE STEP</span>
        <h1 id="auth-heading" tabIndex={-1} ref={heading}>
          Check your inbox.
        </h1>
        <p className="auth-description">
          If this address is eligible, you’ll receive a sign-in link at:
        </p>
        <div className="auth-email-address">
          <Icon name="mail" />
          <strong>{props.demo.email}</strong>
        </div>
        <p className="auth-description auth-link-help">
          Open the link to enter your workspace.
          <br />
          It’s valid for 15 minutes and can be used once.
        </p>
        {flow.sendFailed ? (
          <SendFailure />
        ) : (
          props.demo.sendAttempts > 1 && (
            <p className="auth-success" role="status">
              <Icon name="check" /> Another link requested. Check your inbox.
            </p>
          )
        )}
        <button className="auth-primary" type="button" onClick={props.onSend}>
          Send another link
          <Icon name="arrow" />
        </button>
        <button
          className="auth-text-button"
          type="button"
          onClick={props.onReturn}
        >
          ← Use a different email
        </button>
        <div className="auth-fine-print">
          <Icon name="help" />
          <p>
            Nothing yet? Check your spam folder and make sure you used your work
            email.
          </p>
        </div>
        <p className="auth-demo-hint">
          Demo: open your link using <strong>Prototype controls</strong>.
        </p>
      </section>
    )

  if (flow.step === "expired" || flow.step === "used")
    return (
      <section className="auth-screen" aria-labelledby="auth-heading">
        <div className="auth-symbol auth-symbol-warning">
          <Icon name={flow.step === "expired" ? "clock" : "lock"} />
        </div>
        <span className="eyebrow">LET’S GET YOU A FRESH LINK</span>
        <h1 id="auth-heading" tabIndex={-1} ref={heading}>
          {flow.step === "expired"
            ? "This link has expired."
            : "This link was already used."}
        </h1>
        <p className="auth-description">
          {flow.step === "expired"
            ? "Sign-in links expire after 15 minutes to keep your workspace secure."
            : "Each sign-in link works just once. You can request a new one to sign in again."}
        </p>
        <div className="auth-recovery-note">
          <Icon name="shield" />
          <p>
            Your workspace hasn’t changed.
            <br />
            You just need a new sign-in link.
          </p>
        </div>
        <button className="auth-primary" type="button" onClick={props.onReturn}>
          Back to sign in
          <Icon name="arrow" />
        </button>
      </section>
    )

  return null
}

function SendFailure() {
  return (
    <p className="auth-error" role="alert">
      <Icon name="warning" />
      <span>We couldn’t send your sign-in link. Please try again.</span>
    </p>
  )
}

function Workspace(props: {
  readonly email: string
  readonly onSignOut: () => void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    heading.current?.focus()
  }, [])

  return (
    <div className="app-layout">
      <Sidebar signedIn />
      <div className="app-main">
        <header className="app-topbar">
          <span>
            Workspace <span className="breadcrumb-separator">/</span> Overview
          </span>
          <div className="workspace-user">
            <span className="user-avatar">
              {props.email.slice(0, 1).toUpperCase()}
            </span>
            <span>{props.email}</span>
            <button
              className="auth-sign-out"
              type="button"
              onClick={props.onSignOut}
            >
              Sign out <Icon name="exit" />
            </button>
          </div>
        </header>
        <main className="workspace-content">
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1 tabIndex={-1} ref={heading}>
            You’re in. Welcome to Digital Shelf.
          </h1>
          <p className="workspace-description">
            One place for your catalog, Scrapes and Extractions.
          </p>
          <section className="workspace-welcome" aria-label="Sign-in complete">
            <div className="workspace-complete">
              <Icon name="check" />
            </div>
            <div>
              <span className="eyebrow">SIGN-IN COMPLETE</span>
              <h2>A clear place to start.</h2>
              <p>
                You’re signed in as <strong>{props.email}</strong>.<br />
                The catalog is the next slice. For now, take a look around the
                shell, or sign out to try another layout.
              </p>
            </div>
            <span className="workspace-tag">AUTH PROTOTYPE</span>
          </section>
          <div className="workspace-next-heading">
            <h2>Next, your digital shelf.</h2>
            <span>NOT BUILT IN THIS PROTOTYPE</span>
          </div>
          <div className="workspace-next">
            <section>
              <Icon name="catalog" />
              <span>01 / CONFIGURE</span>
              <h3>Your catalog</h3>
              <p>
                Brands, Products and the Listings you want to keep an eye on.
              </p>
            </section>
            <section>
              <Icon name="scrape" />
              <span>02 / CAPTURE</span>
              <h3>Your Scrapes</h3>
              <p>Fresh captures from Retailers, on demand or on a cadence.</p>
            </section>
            <section>
              <Icon name="data" />
              <span>03 / UNDERSTAND</span>
              <h3>Your Extractions</h3>
              <p>Structured data from each capture, ready to inspect.</p>
            </section>
          </div>
          <p className="workspace-prototype-note">
            <Icon name="help" /> This is a simulated session. Refreshing returns
            you to sign-in.
          </p>
        </main>
      </div>
    </div>
  )
}

function Sidebar(props: { readonly signedIn: boolean }) {
  return (
    <aside className="app-sidebar" aria-label="Workspace sidebar">
      <Wordmark />
      <div className="sidebar-workspace">
        <span className="workspace-avatar">NP</span>
        <div>
          <strong>Nice Pak Brands</strong>
          <span>Shared workspace</span>
        </div>
      </div>
      <span className="sidebar-section-label">WORKSPACE</span>
      <div className="sidebar-nav">
        <span className="sidebar-active">
          <Icon name="home" /> Overview{" "}
          {props.signedIn ? (
            <span className="sidebar-current-dot" />
          ) : (
            <Icon name="lock" />
          )}
        </span>
        <span className="sidebar-section-label sidebar-up-next">
          NEXT SLICE
        </span>
        <span aria-disabled="true">
          <Icon name="catalog" /> Catalog
        </span>
        <span aria-disabled="true">
          <Icon name="scrape" /> Scrapes
        </span>
        <span aria-disabled="true">
          <Icon name="data" /> Extractions
        </span>
      </div>
      <div className="sidebar-bottom">
        <span className="proto-dot" />
        <span>
          {props.signedIn ? "Simulated session" : "Sign in to get started"}
        </span>
      </div>
    </aside>
  )
}

function Wordmark() {
  return (
    <div className="auth-wordmark">
      <span className="auth-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>
        digital shelf<span className="wordmark-period">.</span>
      </span>
    </div>
  )
}

type IconName =
  | "arrow"
  | "mail"
  | "lock"
  | "shield"
  | "help"
  | "clock"
  | "warning"
  | "check"
  | "catalog"
  | "scrape"
  | "data"
  | "home"
  | "exit"
  | "sliders"
  | "reset"

function Icon(props: { readonly name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 6 9 7 9-7" />
      </>
    ),
    lock: (
      <>
        <rect x="5" y="10" width="14" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    help: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2m0 3h.01" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    warning: (
      <>
        <path d="m12 3 10 17H2L12 3Zm0 6v4m0 3h.01" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    catalog: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    scrape: (
      <>
        <path d="M3 5h18v14H3V5Zm0 4h18M6 7h.01M9 7h.01m2 5-3 2 3 2m3-4 3 2-3 2" />
      </>
    ),
    data: (
      <>
        <path d="M8 3H5v7l-2 2 2 2v7h3M16 3h3v7l2 2-2 2v7h-3M9 9h6m-6 6h6" />
      </>
    ),
    home: (
      <>
        <path d="m3 10 9-7 9 7v11H3V10Z" />
        <path d="M9 21v-8h6v8" />
      </>
    ),
    exit: (
      <>
        <path d="M9 4H4v16h5m-1-8h13m-5-5 5 5-5 5" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 7h7m4 0h5M4 17h3m4 0h9" />
        <circle cx="13" cy="7" r="2" />
        <circle cx="9" cy="17" r="2" />
      </>
    ),
    reset: (
      <>
        <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7" />
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
