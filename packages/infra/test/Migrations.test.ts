import { describe, expect, it } from "@effect/vitest"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

// Executes the committed Drizzle migrations against Node's bundled SQLite
// (the same major line workerd pins) with foreign keys on, as D1 runs them,
// and checks that the invariants CONTEXT.md states are enforced by the
// database itself: exactly one Parent per Scrape, composite uniqueness,
// state unions, JSON validity and the cascade graph.

const migrationsDir = join(import.meta.dirname, "../src/Sql/migrations")

const migrationSql = () =>
  readdirSync(migrationsDir)
    .filter((entry) => !entry.startsWith("."))
    .sort()
    .map((entry) =>
      readFileSync(join(migrationsDir, entry, "migration.sql"), "utf8"),
    )
    .join("\n")

const open = () => {
  const db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const statement of migrationSql().split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) db.exec(statement)
  }
  return db
}

const count = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

const seed = (db: DatabaseSync) => {
  db.exec(`
    INSERT INTO brands (id, name, paused) VALUES ('b1', 'Gaia', 0);
    INSERT INTO products (id, brand_id, name, paused) VALUES ('p1', 'b1', 'Bath Wash', 0);
    INSERT INTO variants (id, product_id, name) VALUES ('v1', 'p1', '250ml');
    INSERT INTO retailers (id, name, domain, paused, scrape_mode, scrape_country, listing_extract_prompt, page_extract_prompt)
      VALUES ('r1', 'Chemist Warehouse', 'chemistwarehouse.com.au', 0, 'basic', 'Australia', 'listing prompt', 'page prompt');
    INSERT INTO listings (id, product_id, retailer_id, url, cadence) VALUES ('l1', 'p1', 'r1', 'https://chemistwarehouse.com.au/bath-wash', 'monthly');
    INSERT INTO listing_variants (listing_id, variant_id) VALUES ('l1', 'v1');
    INSERT INTO pages (id, brand_id, retailer_id, url, cadence, paused) VALUES ('pg1', 'b1', 'r1', 'https://chemistwarehouse.com.au/gaia', 'weekly', 0);
    INSERT INTO scrapes (id, listing_id, mode, status, request_url) VALUES ('s1', 'l1', 'basic', 'success', 'https://chemistwarehouse.com.au/bath-wash');
    INSERT INTO scrapes (id, page_id, mode, status, request_url) VALUES ('s2', 'pg1', 'advance', 'pending', 'https://chemistwarehouse.com.au/gaia');
    INSERT INTO extractions (id, scrape_id, attempt, status, prompt_kind, prompt_snapshot, model, extracted_json)
      VALUES ('e1', 's1', 1, 'success', 'listing', 'listing prompt', 'glm-4.7-flash', '{"price": 9.99}');
  `)
}

describe("D1 migrations", () => {
  it("applies with foreign keys on and accepts a valid catalog", () => {
    const db = open()
    seed(db)
    expect(count(db, "scrapes")).toBe(2)
    expect(count(db, "extractions")).toBe(1)
  })

  it("forces exactly one Parent on a Scrape", () => {
    const db = open()
    seed(db)
    const insert = (columns: string, values: string) => () =>
      db.exec(
        `INSERT INTO scrapes (id, ${columns}, mode, status, request_url) VALUES ('sx', ${values}, 'basic', 'pending', 'u')`,
      )
    expect(insert("listing_id, page_id", "'l1', 'pg1'")).toThrow(/CHECK/)
    expect(insert("listing_id, page_id", "NULL, NULL")).toThrow(/CHECK/)
  })

  it("enforces composite uniqueness natively", () => {
    const db = open()
    seed(db)
    expect(() =>
      db.exec(
        "INSERT INTO variants (id, product_id, name) VALUES ('v2', 'p1', '250ML')",
      ),
    ).toThrow(/UNIQUE/)
    expect(() =>
      db.exec(
        "INSERT INTO pages (id, brand_id, retailer_id, url, cadence, paused) VALUES ('pg2', 'b1', 'r1', 'u', 'daily', 0)",
      ),
    ).toThrow(/UNIQUE/)
    expect(() =>
      db.exec(
        "INSERT INTO extractions (id, scrape_id, attempt, status, prompt_kind, prompt_snapshot, model) VALUES ('e2', 's1', 1, 'pending', 'listing', 'p', 'm')",
      ),
    ).toThrow(/UNIQUE/)
    // Listings are deliberately not unique per (Product, Retailer).
    db.exec(
      "INSERT INTO listings (id, product_id, retailer_id, url, cadence) VALUES ('l2', 'p1', 'r1', 'https://chemistwarehouse.com.au/bath-wash', 'monthly')",
    )
    expect(count(db, "listings")).toBe(2)
  })

  it("rejects values outside the state unions and invalid JSON", () => {
    const db = open()
    seed(db)
    expect(() =>
      db.exec("UPDATE scrapes SET status = 'cancelled' WHERE id = 's1'"),
    ).toThrow(/CHECK/)
    expect(() =>
      db.exec(
        "UPDATE scrapes SET error_code = 'schema_mismatch' WHERE id = 's1'",
      ),
    ).toThrow(/CHECK/)
    expect(() =>
      db.exec("UPDATE listings SET cadence = 'Monthly' WHERE id = 'l1'"),
    ).toThrow(/CHECK/)
    expect(() =>
      db.exec("UPDATE brands SET paused = 2 WHERE id = 'b1'"),
    ).toThrow(/CHECK/)
    expect(() =>
      db.exec(
        "UPDATE extractions SET extracted_json = '{not json' WHERE id = 'e1'",
      ),
    ).toThrow(/CHECK/)
  })

  it("cascades a Brand delete down to Extractions", () => {
    const db = open()
    seed(db)
    db.exec("DELETE FROM brands WHERE id = 'b1'")
    for (const table of [
      "products",
      "variants",
      "listings",
      "listing_variants",
      "pages",
      "scrapes",
      "extractions",
    ]) {
      expect(count(db, table), table).toBe(0)
    }
    expect(count(db, "retailers")).toBe(1)
  })

  it("cascades a Retailer delete to its Listings and Pages only", () => {
    const db = open()
    seed(db)
    db.exec("DELETE FROM retailers WHERE id = 'r1'")
    expect(count(db, "listings")).toBe(0)
    expect(count(db, "pages")).toBe(0)
    expect(count(db, "scrapes")).toBe(0)
    expect(count(db, "products")).toBe(1)
    expect(count(db, "variants")).toBe(1)
  })

  it("drops a deleted Variant from coverage and keeps the Listing", () => {
    const db = open()
    seed(db)
    db.exec("DELETE FROM variants WHERE id = 'v1'")
    expect(count(db, "listing_variants")).toBe(0)
    expect(count(db, "listings")).toBe(1)
  })
})
