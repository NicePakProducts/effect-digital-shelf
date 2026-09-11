import { describe, expect, it } from "@effect/vitest"
import { sanitise } from "@digital-shelf/core/Scraping/Sanitise"

describe("sanitise — strip set", () => {
  it("removes <script> blocks but keeps JSON-LD", () => {
    const input = `<html><head>
<script>alert('hi');</script>
<script type="application/ld+json">{"@type":"Product","name":"Widget"}</script>
</head></html>`

    const out = sanitise(input)
    expect(out).not.toContain("alert('hi')")
    expect(out).toContain('"@type":"Product"')
    expect(out).toContain("application/ld+json")
  })

  it("removes <style> blocks", () => {
    const input =
      "<html><head><style>body { color: red; }</style></head><body>x</body></html>"

    const out = sanitise(input)
    expect(out).not.toContain("color: red")
    expect(out).not.toContain("<style")
  })

  it("removes <noscript> blocks", () => {
    const input =
      "<html><body><noscript>js disabled</noscript><p>hi</p></body></html>"

    const out = sanitise(input)
    expect(out).not.toContain("js disabled")
    expect(out).not.toContain("<noscript")
  })

  it("removes HTML comments", () => {
    const input = "<html><body><!-- secret comment --><p>hi</p></body></html>"
    const out = sanitise(input)
    expect(out).not.toContain("secret comment")
    expect(out).not.toContain("<!--")
  })

  it("strips `class` attributes from every element", () => {
    const input = '<div class="foo bar"><span class="baz">hi</span></div>'
    const out = sanitise(input)
    expect(out).not.toContain("class=")
    expect(out).not.toContain("foo bar")
    expect(out).toContain("hi")
  })

  it("strips inline `style` attributes", () => {
    const input = '<div style="color: red">hi</div>'
    const out = sanitise(input)
    expect(out).not.toContain("style=")
    expect(out).not.toContain("color: red")
    expect(out).toContain("hi")
  })

  it("removes <svg> blocks entirely", () => {
    const input =
      '<div>before<svg viewBox="0 0 10 10"><path d="M0 0"/></svg>after</div>'

    const out = sanitise(input)
    expect(out).not.toContain("<svg")
    expect(out).not.toContain("viewBox")
    expect(out).not.toContain("path")
    expect(out).toContain("before")
    expect(out).toContain("after")
  })

  it("strips tracking data-* attributes (data-ga, data-gtm, data-track, data-analytics, data-tealium)", () => {
    const input =
      '<div data-ga-id="abc" data-gtm-event="click" data-track="pageview" data-analytics="x" data-tealium="y" data-product-id="123">hi</div>'

    const out = sanitise(input)
    expect(out).not.toContain("data-ga-id")
    expect(out).not.toContain("data-gtm-event")
    expect(out).not.toContain("data-track")
    expect(out).not.toContain("data-analytics")
    expect(out).not.toContain("data-tealium")
    expect(out).toContain("data-product-id")
    expect(out).toContain("123")
  })
})

describe("sanitise — keep set", () => {
  it("keeps <iframe> blocks (PRD pins this for embedded YouTube widgets)", () => {
    const input =
      '<div><iframe src="https://www.youtube.com/embed/abc123" allow="autoplay"></iframe></div>'

    const out = sanitise(input)
    expect(out).toContain("<iframe")
    expect(out).toContain("youtube.com/embed/abc123")
  })

  it("keeps semantic HTML5 elements (article, section, header, footer, nav, main, aside)", () => {
    const input =
      "<article><header>title</header><section>body</section><footer>foot</footer></article>"

    const out = sanitise(input)
    expect(out).toContain("<article")
    expect(out).toContain("<header")
    expect(out).toContain("<section")
    expect(out).toContain("<footer")
  })

  it("keeps microdata attributes (itemprop, itemscope, itemtype)", () => {
    const input =
      '<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Widget</span></div>'

    const out = sanitise(input)
    expect(out).toContain("itemscope")
    expect(out).toContain("itemtype")
    expect(out).toContain("itemprop")
    expect(out).toContain("Widget")
  })

  it("keeps <meta> tags", () => {
    const input =
      '<head><meta property="og:title" content="Widget"><meta name="description" content="A widget"></head>'

    const out = sanitise(input)
    expect(out).toContain("<meta")
    expect(out).toContain("og:title")
    expect(out).toContain("description")
  })

  it("keeps href / src / alt attributes", () => {
    const input =
      '<a href="https://example.com/x"><img src="https://example.com/i.jpg" alt="Widget photo"></a>'

    const out = sanitise(input)
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('src="https://example.com/i.jpg"')
    expect(out).toContain('alt="Widget photo"')
  })

  it("keeps non-tracking data-* attributes (e.g. data-product-id)", () => {
    const input = '<div data-product-id="123" data-variant="50ml">hi</div>'
    const out = sanitise(input)
    expect(out).toContain("data-product-id")
    expect(out).toContain("123")
    expect(out).toContain("data-variant")
  })

  it("keeps text content across stripped attribute removal", () => {
    const input = '<div class="a" style="color:red"><p>visible text</p></div>'
    const out = sanitise(input)
    expect(out).toContain("visible text")
  })
})
