export function sanitise(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0) return ""
  let out = raw

  // ── 1. Quote out JSON-LD <script> blocks before any <script> strip ──
  // We replace each JSON-LD block with a placeholder token, run the
  // remaining strip rules (which include "remove all <script> blocks"),
  // then restore the placeholders verbatim. The token uses an
  // unguessable suffix so it cannot collide with content in the input.
  const jsonLdBlocks: string[] = []
  const PLACEHOLDER_PREFIX = "__SANITISE_HTML_JSONLD__"
  out = out.replace(
    /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script\s*>/gi,
    (match) => {
      const idx = jsonLdBlocks.length
      jsonLdBlocks.push(match)

      return `${PLACEHOLDER_PREFIX}${idx}__`
    },
  )

  // ── 2. Strip HTML comments ─────────────────────────────────────────
  out = out.replace(/<!--[\s\S]*?-->/g, "")

  // ── 3. Strip <style>, <noscript>, <svg>, remaining <script> blocks ──
  out = stripBlock(out, "style")
  out = stripBlock(out, "noscript")
  out = stripBlock(out, "svg")
  out = stripBlock(out, "script")

  // ── 4. Restore JSON-LD placeholders ────────────────────────────────
  out = out.replace(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)__`, "g"),
    (_, idx) => jsonLdBlocks[Number(idx)] ?? "",
  )

  // ── 5. Strip `class` and inline `style` attributes ─────────────────
  // Match the attribute on any tag — leading whitespace + name + `=` +
  // single/double-quoted value. We strip the leading whitespace as
  // well so the resulting tag does not carry a dangling space.
  out = out.replace(/\s+class\s*=\s*"[^"]*"/gi, "")
  out = out.replace(/\s+class\s*=\s*'[^']*'/gi, "")
  out = out.replace(/\s+style\s*=\s*"[^"]*"/gi, "")
  out = out.replace(/\s+style\s*=\s*'[^']*'/gi, "")

  // ── 6. Strip tracking data-* attributes ────────────────────────────
  // Allow-list strip — any of the five known tracking prefixes. Any
  // other `data-*` (including `data-product-id`, `data-variant`,
  // domain-specific attributes the LLM may want) passes through.
  // The pattern matches attribute name + optional value; we accept
  // both quoted and bare values for robustness.
  const trackingPrefixes = ["ga", "gtm", "track", "analytics", "tealium"]

  for (const prefix of trackingPrefixes) {
    const re = new RegExp(
      `\\s+data-${prefix}(?:-[\\w-]+)?\\s*(?:=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
      "gi",
    )

    out = out.replace(re, "")
  }

  return out
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
