import {
  RetailersErrors,
  Retailers,
  canonicalDomain,
} from "@app/core/retailers"
import { expect, it } from "@effect/vitest"
import { Retailer } from "@app/schema/retailer"
import { RetailerId } from "@app/schema/ids"
import { Effect, Option, Schema } from "effect"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Retailers", (it) => {
  it.effect(
    "canonicalises URLs, bare hosts and hosts with paths, and refuses invalid hosts and IP literals",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset

        for (const input of [
          "https://www.ChemistWarehouse.com.au/shop-online",
          "chemistwarehouse.com.au",
          "chemistwarehouse.com.au:443",
          " www.ChemistWarehouse.com.au/shop-online ",
        ]) {
          expect(Option.getOrThrow(canonicalDomain(input))).toBe(
            "chemistwarehouse.com.au",
          )
        }

        for (const input of [
          "example.com:8080",
          "www.Example.com:443/path",
          "http://EXAMPLE.com:8080/x",
        ])
          expect(canonicalDomain(input)).toEqual(Option.some("example.com"))

        for (const input of [
          "localhost",
          "foo",
          "not a host",
          "",
          "127.0.0.1",
          "https://[::1]/",
          "127.1",
        ])
          expect(Option.isNone(canonicalDomain(input))).toBe(true)
      }),
  )
  it.effect("stores the canonical host and seeds all omitted defaults", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const retailers = yield* Retailers.Service

      const row = yield* retailers.create({
        name: "Shop",
        domain: "https://www.ChemistWarehouse.com.au/shop-online",
      })

      expect(row.domain).toBe("chemistwarehouse.com.au")
      expect(row.paused).toBe(false)
      expect(row.scrapeMode).toBe("basic")
      expect(row.scrapeCountry).toBe("Australia")
      expect(row.listingExtractPrompt).toBe(
        Retailer.defaultListingExtractPrompt,
      )
      expect(row.pageExtractPrompt).toBe(Retailer.defaultPageExtractPrompt)
      expect(yield* retailers.get({ retailerId: row.id })).toEqual(row)
      expect(yield* retailers.list).toEqual([row])
    }),
  )
  it.effect(
    "reports the domain holder after a differently pasted duplicate rolls back",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const retailers = yield* Retailers.Service

        const row = yield* retailers.create({
          name: "Shop",
          domain: "example.com",
        })

        expect(
          yield* Effect.flip(
            retailers.create({
              name: "Other",
              domain: "https://WWW.EXAMPLE.COM/path",
            }),
          ),
        ).toEqual(
          new RetailersErrors.DomainTaken({
            domain: "example.com",
            retailerId: row.id,
          }),
        )
        expect((yield* retailers.list).length).toBe(1)
      }),
  )
  it.effect("returns InvalidRetailerDomain with the pasted input", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const retailers = yield* Retailers.Service
      expect(
        yield* Effect.flip(
          retailers.create({ name: "Shop", domain: "localhost" }),
        ),
      ).toEqual(new RetailersErrors.InvalidDomain({ input: "localhost" }))
    }),
  )
  it.effect(
    "canonicalises a changed domain and rejects a taken domain without changing the row",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const retailers = yield* Retailers.Service

        const a = yield* retailers.create({
          name: "A",
          domain: "a.example.com",
        })

        const b = yield* retailers.create({
          name: "B",
          domain: "b.example.com",
        })

        expect(
          (yield* retailers.update({
            retailerId: a.id,
            command: {
              domain: "https://www.NEW.example.com/path",
            },
          })).domain,
        ).toBe("new.example.com")
        expect(
          yield* Effect.flip(
            retailers.update({
              retailerId: a.id,
              command: { domain: "https://b.example.com/path" },
            }),
          ),
        ).toEqual(
          new RetailersErrors.DomainTaken({
            domain: b.domain,
            retailerId: b.id,
          }),
        )
        expect((yield* retailers.get({ retailerId: a.id })).domain).toBe(
          "new.example.com",
        )
        expect(
          yield* Effect.flip(
            retailers.update({ retailerId: a.id, command: { domain: "foo" } }),
          ),
        ).toEqual(new RetailersErrors.InvalidDomain({ input: "foo" }))
      }),
  )
  it.effect("reports a missing Retailer for reads, writes and impact", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const retailers = yield* Retailers.Service

      const id = Schema.decodeUnknownSync(RetailerId)(
        "00000000-0000-4000-8000-000000000404",
      )

      const error = new RetailersErrors.NotFound({ retailerId: id })
      expect(yield* Effect.flip(retailers.get({ retailerId: id }))).toEqual(
        error,
      )
      expect(
        yield* Effect.flip(retailers.update({ retailerId: id, command: {} })),
      ).toEqual(error)
      expect(yield* Effect.flip(retailers.impact({ retailerId: id }))).toEqual(
        error,
      )
      expect(yield* Effect.flip(retailers.remove({ retailerId: id }))).toEqual(
        error,
      )
    }),
  )
})
