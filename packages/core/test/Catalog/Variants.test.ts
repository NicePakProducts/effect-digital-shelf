import {
  ProductVariantsErrors,
  ProductVariants,
} from "@app/core/products/variants"
import { ProductsErrors } from "@app/core/products"
import { Db } from "@app/db"
import { query } from "@app/core/Sql/Errors"
import { ProductsRepo } from "../../src/products/repository"
import { Cascade } from "@app/core/cascade"
import { VariantsRepo } from "../../src/products/variants/repository"
import { isSqlError } from "effect/unstable/sql/SqlError"
import { sql } from "drizzle-orm"
import { expect, it } from "@effect/vitest"
import { Listings } from "@app/core/listings"
import { ProductId, VariantId } from "@app/schema/ids"
import { emptyImpact } from "@app/schema/cascade"
import { Effect, Layer, Schema } from "effect"
import * as CoreTest from "../layers/Core"
import * as DbTest from "../layers/Db"
import { seed } from "../fixtures/Catalog"

it.layer(CoreTest.TestLayer, { timeout: "60 seconds" })("Variants", (it) => {
  it.effect(
    "layerNoDeps rejects a missing parent before attempting an insert",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const db = yield* Db

        const DependenciesLayer = Layer.mergeAll(
          ProductsRepo.layer,
          VariantsRepo.layer,
          Cascade.layer,
        )

        const variants = yield* ProductVariants.Service.pipe(
          Effect.provide(
            ProductVariants.layerNoDeps.pipe(Layer.provide(DependenciesLayer)),
          ),
        )

        // A sequence records even rolled-back attempts; an empty table alone would
        // not distinguish the preliminary guard from the authoritative FK failure.
        yield* query(db.execute("CREATE SEQUENCE variant_insert_attempt"))
        yield* query(
          db.execute(
            "CREATE FUNCTION record_variant_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM nextval('variant_insert_attempt'); RETURN NEW; END $$",
          ),
        )
        yield* query(
          db.execute(
            "CREATE TRIGGER record_variant_attempt BEFORE INSERT ON variants FOR EACH ROW EXECUTE FUNCTION record_variant_attempt()",
          ),
        )

        const productId = Schema.decodeUnknownSync(ProductId)(
          "00000000-0000-4000-8000-000000000404",
        )

        expect(
          yield* Effect.flip(variants.create({ productId, name: "Missing" })),
        ).toEqual(new ProductsErrors.NotFound({ productId }))

        const attempted = () =>
          query(db.execute("SELECT is_called FROM variant_insert_attempt"))

        expect(yield* attempted()).toMatchObject({
          rows: [{ is_called: false }],
        })

        const created = yield* variants.create({
          productId: c.productId,
          name: "Present",
        })

        expect(created.productId).toBe(c.productId)
        expect(yield* attempted()).toMatchObject({
          rows: [{ is_called: true }],
        })
        yield* query(
          db.execute("DROP TRIGGER record_variant_attempt ON variants"),
        )
        yield* query(db.execute("DROP FUNCTION record_variant_attempt()"))
        yield* query(db.execute("DROP SEQUENCE variant_insert_attempt"))
      }),
  )
  it.effect(
    "does not relabel unrelated FK, primary-key or check violations and preserves diagnostics",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const db = yield* Db
        const variants = yield* ProductVariants.Service

        const repository = yield* VariantsRepo.Service.pipe(
          Effect.provide(VariantsRepo.layer),
        )

        const first = yield* variants.create({
          productId: c.productId,
          name: "Primary",
        })

        const duplicate = yield* Effect.flip(
          repository.insert({
            id: first.id,
            productId: c.productId,
            name: "Other",
          }),
        )

        expect(isSqlError(duplicate)).toBe(true)

        if (isSqlError(duplicate))
          expect(duplicate.reason).toMatchObject({
            constraint: "variants_pkey",
          })
        yield* query(
          db.execute(
            sql`CREATE TABLE variant_allowed_parents (id uuid PRIMARY KEY)`,
          ),
        )
        yield* query(
          db.execute(
            sql`ALTER TABLE variants ADD CONSTRAINT variant_fixture_parent FOREIGN KEY (product_id) REFERENCES variant_allowed_parents(id) NOT VALID`,
          ),
        )

        const unrelated = yield* Effect.flip(
          variants.create({ productId: c.productId, name: "Unrelated FK" }),
        )

        expect(isSqlError(unrelated)).toBe(true)

        if (isSqlError(unrelated))
          expect(unrelated.reason.cause).toMatchObject({
            code: "23503",
            constraint: "variant_fixture_parent",
          })
        yield* query(
          db.execute(
            sql`ALTER TABLE variants DROP CONSTRAINT variant_fixture_parent`,
          ),
        )
        yield* query(db.execute(sql`DROP TABLE variant_allowed_parents`))
        yield* query(
          db.execute(
            sql`ALTER TABLE variants ADD CONSTRAINT variant_fixture_check CHECK (name <> 'Rejected')`,
          ),
        )

        const check = yield* Effect.flip(
          variants.create({ productId: c.productId, name: "Rejected" }),
        )

        expect(isSqlError(check)).toBe(true)

        if (isSqlError(check))
          expect(check.reason.cause).toMatchObject({
            code: "23514",
            constraint: "variant_fixture_check",
          })
        yield* query(
          db.execute(
            sql`ALTER TABLE variants DROP CONSTRAINT variant_fixture_check`,
          ),
        )
      }),
  )
  it.effect(
    "rejects case-insensitive duplicates within one Product and permits the same name under another",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const a = yield* seed()
        const b = yield* seed()
        const variants = yield* ProductVariants.Service
        yield* variants.create({ productId: a.productId, name: "500 ML" })
        expect(
          yield* Effect.flip(
            variants.create({ productId: a.productId, name: "500 ml" }),
          ),
        ).toEqual(
          new ProductVariantsErrors.DuplicateName({
            productId: a.productId,
            name: "500 ml",
          }),
        )
        expect(
          (yield* variants.create({ productId: b.productId, name: "500 ml" }))
            .productId,
        ).toBe(b.productId)
        expect((yield* variants.list({ productId: a.productId })).length).toBe(
          1,
        )
      }),
  )
  it.effect("rejects renaming onto another Variant name", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const seeded = yield* seed()
      const productId = seeded.productId
      const variants = yield* ProductVariants.Service
      yield* variants.create({ productId, name: "500 ML" })
      const row = yield* variants.create({ productId, name: "1 L" })
      expect(
        yield* Effect.flip(
          variants.update({ variantId: row.id, command: { name: "500 ml" } }),
        ),
      ).toEqual(
        new ProductVariantsErrors.DuplicateName({ productId, name: "500 ml" }),
      )
      expect((yield* variants.get({ variantId: row.id })).name).toBe("1 L")
    }),
  )
  it.effect(
    "removes only coverage edges and returns empty impact while the Listing survives",
    () =>
      Effect.gen(function* () {
        yield* DbTest.reset
        const c = yield* seed()
        const variants = yield* ProductVariants.Service
        const a = yield* variants.create({ productId: c.productId, name: "A" })
        const b = yield* variants.create({ productId: c.productId, name: "B" })
        const listings = yield* Listings.Service

        const listing = yield* listings.create({
          productId: c.productId,
          retailerId: c.retailerId,
          url: c.url("/item"),
          variantIds: [a.id, b.id],
        })

        expect(yield* variants.remove({ variantId: a.id })).toEqual(emptyImpact)
        expect(
          (yield* listings.get({ listingId: listing.id })).variantIds,
        ).toEqual([b.id])
      }),
  )
  it.effect("returns the specific missing parent or Variant id", () =>
    Effect.gen(function* () {
      yield* DbTest.reset
      const variants = yield* ProductVariants.Service
      const id = "00000000-0000-4000-8000-000000000404"
      const productId = Schema.decodeUnknownSync(ProductId)(id)
      const variantId = Schema.decodeUnknownSync(VariantId)(id)
      expect(
        yield* Effect.flip(variants.create({ productId, name: "A" })),
      ).toEqual(new ProductsErrors.NotFound({ productId }))
      expect(yield* Effect.flip(variants.get({ variantId }))).toEqual(
        new ProductVariantsErrors.NotFound({ variantId }),
      )
      expect(
        yield* Effect.flip(
          variants.update({ variantId, command: { name: "A" } }),
        ),
      ).toEqual(new ProductVariantsErrors.NotFound({ variantId }))
      expect(yield* Effect.flip(variants.remove({ variantId }))).toEqual(
        new ProductVariantsErrors.NotFound({ variantId }),
      )
    }),
  )
})
