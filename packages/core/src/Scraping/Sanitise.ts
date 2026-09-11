import { pipe } from "effect/Function"
import * as Schema from "effect/Schema"

export function sanitise(raw: string): string {
  if (!Schema.is(Schema.String)(raw) || raw.length === 0) return ""

  // Preserve JSON-LD through generic script stripping, then restore it before attribute stripping.
  const jsonLdBlocks: string[] = []
  const PLACEHOLDER_PREFIX = "__SANITISE_HTML_JSONLD__"
  const trackingPrefixes = ["ga", "gtm", "track", "analytics", "tealium"]

  return pipe(
    raw,
    (html) =>
      html.replace(
        /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi,
        (match) => {
          const idx = jsonLdBlocks.length
          jsonLdBlocks.push(match)

          return `${PLACEHOLDER_PREFIX}${idx}__`
        },
      ),
    (html) => html.replace(/<!--[\s\S]*?-->/g, ""),
    (html) => stripBlock(html, "style"),
    (html) => stripBlock(html, "noscript"),
    (html) => stripBlock(html, "svg"),
    (html) => stripBlock(html, "script"),
    (html) =>
      html.replace(
        new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)__`, "g"),
        (_, idx) => jsonLdBlocks[Number(idx)] ?? "",
      ),
    (html) =>
      html
        .replace(/\s+class\s*=\s*"[^"]*"/gi, "")
        .replace(/\s+class\s*=\s*'[^']*'/gi, "")
        .replace(/\s+style\s*=\s*"[^"]*"/gi, "")
        .replace(/\s+style\s*=\s*'[^']*'/gi, ""),
    // Strip only known tracking prefixes; retain product and retailer-specific data attributes.
    (html) =>
      trackingPrefixes.reduce(
        (html, prefix) =>
          html.replace(
            new RegExp(
              `\\s+data-${prefix}(?:-[\\w-]+)?\\s*(?:=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
              "gi",
            ),
            "",
          ),
        html,
      ),
  )
}

/**
 * Remove every `<tag …>…</tag>` block (greedy across the body, lazy
 * across the closing tag) plus self-closing forms. The body matcher
 * is `[\s\S]*?` so it handles multiline content and is lazy so two
 * adjacent blocks do not collapse into one.
 *
 * Also strips trailing whitespace left behind so a stripped block on
 * its own line does not leave a blank line in the output.
 */
function stripBlock(html: string, tag: string): string {
  // Paired form: <tag …>…</tag>
  const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, "gi")
  // Self-closing form: <tag … />
  const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/>`, "gi")

  // Void / unclosed form: <tag …> with no closer in the document. We
  // do NOT strip this generically because it would eat unrelated
  // content; the paired form is the load-bearing match for our use
  // case (every <script>/<style>/<noscript>/<svg> in real retailer
  // HTML has a matching closer).
  return html.replace(paired, "").replace(selfClosing, "")
}
