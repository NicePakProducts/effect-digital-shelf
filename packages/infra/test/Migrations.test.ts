import { beforeAll, describe, expect, it } from "@effect/vitest"
import { PGlite } from "@electric-sql/pglite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Executes the committed Drizzle migrations against PGlite (Postgres in
// process) and checks that the invariants CONTEXT.md states are enforced by
// the database itself: exactly one Parent per Scrape, composite uniqueness,
// the state enums and error-code CHECKs, JSON validity and the cascade
// graph. PlanetScale runs the same DDL; a deployed smoke covers the driver.

const migrationsDir = join(import.meta.dirname, "../src/Sql/migrations")

const migrationSql = () =>
  readdirSync(migrationsDir)
    .filter((entry) => !entry.startsWith("."))
    .sort()
    .map((entry) =>
      readFileSync(join(migrationsDir, entry, "migration.sql"), "utf8"),
    )
    .join("\n")

// One PGlite per file: booting Postgres is the slow part. Every test starts
// from an empty catalog by truncating the roots; the cascade does the rest.
const pglite = new PGlite()

beforeAll(async () => {
  for (const statement of migrationSql().split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) await pglite.exec(statement)
  }
})

const open = async () => {
  await pglite.exec("TRUNCATE brands, retailers CASCADE")
  return pglite
}

const count = async (db: PGlite, table: string) =>
  Number(
    (await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))
      .rows[0]?.n,
  )

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const b1 = id(1)
const p1 = id(2)
const v1 = id(3)
const r1 = id(4)
const l1 = id(5)
const pg1 = id(6)
const s1 = id(7)
const s2 = id(8)
const e1 = id(9)

const seed = (db: PGlite) =>
  db.exec(`
    INSERT INTO brands (id, name) VALUES ('${b1}', 'Gaia');
    INSERT INTO products (id, brand_id, name) VALUES ('${p1}', '${b1}', 'Bath Wash');
    INSERT INTO variants (id, product_id, name) VALUES ('${v1}', '${p1}', '250ml');
    INSERT INTO retailers (id, name, domain, scrape_mode, scrape_country, listing_extract_prompt, page_extract_prompt)
      VALUES ('${r1}', 'Chemist Warehouse', 'chemistwarehouse.com.au', 'basic', 'Australia', 'listing prompt', 'page prompt');
    INSERT INTO listings (id, product_id, retailer_id, url, cadence) VALUES ('${l1}', '${p1}', '${r1}', 'https://chemistwarehouse.com.au/bath-wash', 'monthly');
    INSERT INTO listing_variants (listing_id, variant_id) VALUES ('${l1}', '${v1}');
    INSERT INTO pages (id, brand_id, retailer_id, url, cadence) VALUES ('${pg1}', '${b1}', '${r1}', 'https://chemistwarehouse.com.au/gaia', 'weekly');
    INSERT INTO scrapes (id, listing_id, mode, status, request_url) VALUES ('${s1}', '${l1}', 'basic', 'success', 'https://chemistwarehouse.com.au/bath-wash');
    INSERT INTO scrapes (id, page_id, mode, status, request_url) VALUES ('${s2}', '${pg1}', 'advance', 'pending', 'https://chemistwarehouse.com.au/gaia');
    INSERT INTO extractions (id, scrape_id, attempt, status, prompt_kind, prompt_snapshot, model, extracted_json)
      VALUES ('${e1}', '${s1}', 1, 'success', 'listing', 'listing prompt', 'glm-4.7-flash', '{"price": 9.99}');
  `)

describe("Postgres migrations", () => {
  it("applies and accepts a valid catalog", async () => {
    const db = await open()
    await seed(db)
    expect(await count(db, "scrapes")).toBe(2)
    expect(await count(db, "extractions")).toBe(1)
  })

  it("forces exactly one Parent on a Scrape", async () => {
    const db = await open()
    await seed(db)
    const insert = (values: string) =>
      db.exec(
        `INSERT INTO scrapes (id, listing_id, page_id, mode, status, request_url) VALUES ('${id(99)}', ${values}, 'basic', 'pending', 'u')`,
      )
    await expect(insert(`'${l1}', '${pg1}'`)).rejects.toThrow(
      /check constraint/,
    )
    await expect(insert("NULL, NULL")).rejects.toThrow(/check constraint/)
  })

  it("enforces composite uniqueness natively", async () => {
    const db = await open()
    await seed(db)
    await expect(
      db.exec(
        `INSERT INTO variants (id, product_id, name) VALUES ('${id(10)}', '${p1}', '250ML')`,
      ),
    ).rejects.toThrow(/unique/)
    await expect(
      db.exec(
        `INSERT INTO pages (id, brand_id, retailer_id, url, cadence) VALUES ('${id(11)}', '${b1}', '${r1}', 'u', 'daily')`,
      ),
    ).rejects.toThrow(/unique/)
    await expect(
      db.exec(
        `INSERT INTO extractions (id, scrape_id, attempt, status, prompt_kind, prompt_snapshot, model) VALUES ('${id(12)}', '${s1}', 1, 'pending', 'listing', 'p', 'm')`,
      ),
    ).rejects.toThrow(/unique/)
    // Listings are deliberately not unique per (Product, Retailer).
    await db.exec(
      `INSERT INTO listings (id, product_id, retailer_id, url, cadence) VALUES ('${id(13)}', '${p1}', '${r1}', 'https://chemistwarehouse.com.au/bath-wash', 'monthly')`,
    )
    expect(await count(db, "listings")).toBe(2)
  })

  it("rejects values outside the state unions and invalid JSON", async () => {
    const db = await open()
    await seed(db)
    await expect(
      db.exec(`UPDATE scrapes SET status = 'cancelled' WHERE id = '${s1}'`),
    ).rejects.toThrow(/enum/)
    await expect(
      db.exec(
        `UPDATE scrapes SET error_code = 'schema_mismatch' WHERE id = '${s1}'`,
      ),
    ).rejects.toThrow(/check constraint/)
    await expect(
      db.exec(`UPDATE listings SET cadence = 'Monthly' WHERE id = '${l1}'`),
    ).rejects.toThrow(/enum/)
    await expect(
      db.exec(
        `UPDATE extractions SET extracted_json = '{not json' WHERE id = '${e1}'`,
      ),
    ).rejects.toThrow(/json/)
  })

  it("cascades a Brand delete down to Extractions", async () => {
    const db = await open()
    await seed(db)
    await db.exec(`DELETE FROM brands WHERE id = '${b1}'`)
    for (const table of [
      "products",
      "variants",
      "listings",
      "listing_variants",
      "pages",
      "scrapes",
      "extractions",
    ]) {
      expect(await count(db, table), table).toBe(0)
    }
    expect(await count(db, "retailers")).toBe(1)
  })

  it("cascades a Retailer delete to its Listings and Pages only", async () => {
    const db = await open()
    await seed(db)
    await db.exec(`DELETE FROM retailers WHERE id = '${r1}'`)
    expect(await count(db, "listings")).toBe(0)
    expect(await count(db, "pages")).toBe(0)
    expect(await count(db, "scrapes")).toBe(0)
    expect(await count(db, "products")).toBe(1)
    expect(await count(db, "variants")).toBe(1)
  })

  it("drops a deleted Variant from coverage and keeps the Listing", async () => {
    const db = await open()
    await seed(db)
    await db.exec(`DELETE FROM variants WHERE id = '${v1}'`)
    expect(await count(db, "listing_variants")).toBe(0)
    expect(await count(db, "listings")).toBe(1)
  })
})
