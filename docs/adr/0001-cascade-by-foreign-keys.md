# Cascade is enforced by database foreign keys

Every delete in the digital shelf is hard and cascades (CONTEXT.md, "Cascade"). We enforce that graph with `ON DELETE CASCADE` foreign keys in Postgres rather than with core code issuing batched deletes, because a single statement removes the whole subtree inside one transaction, with no window in which a child outlives its parent. The Variant coverage edge is a join table whose two foreign keys both cascade, so deleting a Variant removes only edge rows and the Listing survives. R2 objects (stored HTML, provider response) are removed by core after the database delete succeeds: a failed R2 delete leaves an orphan object for the retention sweep, never a row without its parent.

Originally written for D1; the decision carried over unchanged when the store moved to Postgres (PlanetScale via Hyperdrive), which also enforces foreign keys and drops the SQLite "recreate table" migration trap that the first version of this ADR warned about.

## Consequences

- Core must collect the Scrape ids it is about to remove before the delete, both for R2 cleanup and for the cascade impact count; the database will not report them.
- Until the first production deploy, migrations are regenerated rather than appended, so the initial migration is the one that first reaches Postgres.
- The previous app's ADR 0005 (synthetic composite keys) is superseded: uniqueness is native multi-column indexes.
