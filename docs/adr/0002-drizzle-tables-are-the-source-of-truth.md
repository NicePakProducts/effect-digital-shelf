# Drizzle tables are the source of truth for entity schemas

_Placement and wiring superseded by [ADR 0011](0011-explicit-packages-and-feature-owned-persistence.md); the historical decision below is retained._

Each entity (Brand, Product, Variant, Retailer, Listing, Page, Scrape, Extraction) has one definition: its Drizzle `pgTable` in `packages/domain/src/Sql/`. The Effect entity schemas are derived from those tables with `drizzle-orm/effect-schema` (`createSelectSchema`, `createInsertSchema`, `createUpdateSchema`), with a small refine layer swapping in the domain vocabulary: branded ids, `DateTime.Utc` for timestamps, `Option` for nullable columns, literal unions for status and error codes. We chose this over hand-written `Model.Class` or `Schema.Class` entities because one declaration cannot drift from the other: a column change that the refine layer does not follow fails type checking in the domain tests, not at runtime against a live database.

## Considered options

- **Hand-written entity schemas beside a separate Drizzle schema in core.** Rejected: two declarations of the same shape with nothing but review keeping them aligned.
- **Tables in a `db` package that domain depends on.** Rejected (with Codex as second reviewer): the tables would still be the definition of the entities, so splitting them out only adds a package for the same dependency edge. The tables stay in domain, isolated in `Sql/`, and that is the documented exception to "domain depends on nothing but Effect".

## Consequences

- Derive wholesale until an entity genuinely diverges from its row (a computed field, a shape that is not a projection of columns). At that point hand-write that one entity and keep its test asserting the row still decodes into it; do not bend the table to fit the entity.
- The wire shape of an entity is an explicit pick/omit projection of the entity, decided per endpoint in the API contracts, never the entity itself.
- Command inputs (`*Management.ts`) are hand-written structs, not derived insert schemas: what an API caller may say is a product decision, not a column list.
- `drizzle-kit generate` reads the domain tables through `packages/infra/drizzle.config.ts`; migrations live in infra and are proven against PGlite in infra's tests.
- Auth tables (better-auth's user, session, account, verification) also live in `packages/domain/src/Sql/`, as `Auth.ts`, so one schema drives one migration set; they get no derived entity schemas because nothing in the domain reads them as entities.
