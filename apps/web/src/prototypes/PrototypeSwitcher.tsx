import { useEffect } from "react"

export type PrototypeVariant = "A" | "B" | "C"

const variants: ReadonlyArray<PrototypeVariant> = ["A", "B", "C"]

const names = { A: "Focused", B: "Minimal", C: "App-first" }

interface PrototypeSwitcherProps {
  readonly variant: PrototypeVariant
  readonly onChange: (variant: PrototypeVariant) => void
}

export function PrototypeSwitcher(props: PrototypeSwitcherProps) {
  useEffect(() => {
    if (import.meta.env.PROD) return

    const onKeyDown = (event: KeyboardEvent) => {
      const focused = document.activeElement

      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        focused?.closest("input, textarea, select, [contenteditable]")
      )
        return

      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      event.preventDefault()
      props.onChange(
        adjacentVariant(props.variant, event.key === "ArrowLeft" ? -1 : 1),
      )
    }

    document.addEventListener("keydown", onKeyDown)

    return () => document.removeEventListener("keydown", onKeyDown)
  }, [props.variant, props.onChange])

  if (import.meta.env.PROD) return null

  return (
    <nav className="proto-switcher" aria-label="Prototype layouts">
      <span className="proto-switcher-caption">EXPLORE LAYOUTS</span>
      <div className="proto-switcher-pill">
        <button
          type="button"
          aria-label="Previous layout"
          onClick={() => props.onChange(adjacentVariant(props.variant, -1))}
        >
          ←
        </button>
        <div className="proto-switcher-label" aria-live="polite">
          <span className="proto-switcher-letter">{props.variant}</span>
          <strong>{names[props.variant]}</strong>
          <span className="proto-switcher-count">
            {variants.indexOf(props.variant) + 1} / 3
          </span>
        </div>
        <button
          type="button"
          aria-label="Next layout"
          onClick={() => props.onChange(adjacentVariant(props.variant, 1))}
        >
          →
        </button>
      </div>
    </nav>
  )
}

function adjacentVariant(
  current: PrototypeVariant,
  direction: number,
): PrototypeVariant {
  return variants[
    (variants.indexOf(current) + direction + variants.length) % variants.length
  ]!
}
