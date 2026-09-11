import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import { hostMatches } from "@digital-shelf/domain/Catalog/Retailer"
import { Url } from "@digital-shelf/domain/Shared/Refine"

const decode = Schema.decodeUnknownSync(Url)

const encode = Schema.encodeSync(Url)

/**
 * The URL invariants settled on the map's "URL invariants" ticket: `Url` is a
 * normalising transformation, and `hostMatches` is the host rule the Catalog
 * features enforce against a Retailer row.
 */
describe("Url", () => {
  it("keeps a parameter that selects content while dropping the tracker beside it", () => {
    expect(decode("https://www.amazon.com.au/dp/B01?th=1&ref_=pd_sim")).toBe(
      "https://www.amazon.com.au/dp/B01?th=1",
    )
    // A bare `ref` is not a Tracker parameter, and a tracker in the path stays.
    expect(decode("https://www.amazon.com.au/gp/ref=nosim/x?ref=1")).toBe(
      "https://www.amazon.com.au/gp/ref=nosim/x?ref=1",
    )
  })

  it("preserves duplicate keys, their order and encoded bytes", () => {
    const url =
      "https://shop.example.com/Path%20A?b=2&a=1&a=3&q=%E2%9C%93&empty=&flag"

    expect(decode(`${url}&utm_source=news&gclid=abc`)).toBe(url)
  })

  it("keeps the fragment and drops a query left empty", () => {
    expect(decode("https://shop.example.com/p?utm_medium=email#reviews")).toBe(
      "https://shop.example.com/p#reviews",
    )
    expect(decode("https://shop.example.com/p?")).toBe(
      "https://shop.example.com/p",
    )
    expect(decode("https://shop.example.com/p?fbclid=x")).toBe(
      "https://shop.example.com/p",
    )
  })

  it("trims, lower-cases scheme and host, and leaves path, port and case below the host alone", () => {
    expect(decode("  HTTPS://WWW.Example.COM:8443/Path/Item?A=B  ")).toBe(
      "https://www.example.com:8443/Path/Item?A=B",
    )
    // No trailing slash is added and http is never upgraded.
    expect(decode("http://example.com")).toBe("http://example.com")
  })

  it("is idempotent, and encoding hands the stored form back", () => {
    for (const input of [
      "  HTTPS://WWW.Example.COM/dp/B01?utm_source=a&th=1&ref_=z#frag  ",
      "https://shop.example.com/p?a=1&a=2",
      "https://example.com",
      "https://example.com/p?",
    ]) {
      const once = decode(input)
      expect(decode(once)).toBe(once)
      expect(encode(once)).toBe(once)
    }
  })

  it("encodes any accepted string to the stored form, not as pasted", () => {
    // The write path: a row schema encodes whatever string core was handed.
    expect(encode("  HTTPS://WWW.BigW.com.au/p/2?utm_source=a&th=1  ")).toBe(
      "https://www.bigw.com.au/p/2?th=1",
    )
    expect(() => encode("not a url")).toThrow()
  })

  it("keeps an unparsable or non-http value a schema failure", () => {
    for (const input of [
      "Gaia Body Wash 500ml",
      "example.com/dp/B01",
      "ftp://example.com/x",
      "   ",
      "",
      42,
    ])
      expect(() => decode(input)).toThrow()
  })
})

describe("hostMatches", () => {
  it("accepts the domain itself and its subdomains on a dot boundary", () => {
    expect(hostMatches("https://bigw.com.au/p", "bigw.com.au")).toBe(true)
    expect(hostMatches("https://shop.bigw.com.au/p", "bigw.com.au")).toBe(true)
    expect(hostMatches("https://a.b.bigw.com.au/p", "bigw.com.au")).toBe(true)
  })

  it("rejects a lookalike suffix and an unrelated host", () => {
    expect(hostMatches("https://evilbigw.com.au/p", "bigw.com.au")).toBe(false)
    expect(hostMatches("https://bigw.com.au.evil.com/p", "bigw.com.au")).toBe(
      false,
    )
    expect(hostMatches("https://woolworths.com.au/p", "bigw.com.au")).toBe(
      false,
    )
  })

  it("ignores a leading www. on either side, and case", () => {
    expect(hostMatches("https://www.bigw.com.au/p", "bigw.com.au")).toBe(true)
    expect(hostMatches("https://bigw.com.au/p", "www.bigw.com.au")).toBe(true)
    expect(hostMatches("https://WWW.BigW.com.au/p", "BIGW.COM.AU")).toBe(true)
    // Only a leading `www.` is stripped, never one deeper in the host.
    expect(hostMatches("https://shop.www.bigw.com.au/p", "bigw.com.au")).toBe(
      true,
    )
  })

  it("never matches a value the parser rejects", () => {
    expect(hostMatches("Gaia Body Wash", "bigw.com.au")).toBe(false)
  })
})
