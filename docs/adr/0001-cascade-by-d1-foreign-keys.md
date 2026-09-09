# Cascade is enforced by D1 foreign keys

Every delete in the digital shelf is hard and cascades (CONTEXT.md, "Cascade"). We enforce that graph with `ON DELETE CASCADE` foreign keys in D1 rather than with core code issuing batched deletes, because D1 enforces foreign keys by default and a single statement removes the whole subtree with no window in which a child outlives its parent. The Variant coverage edge is a join table whose two foreign keys both cascade, so deleting a Variant removes only edge rows and the Listing survives. R2 objects (stored HTML, provider response) are removed by core after the database delete succeeds: a failed R2 delete leaves an orphan object for the retention sweep, never a row without its parent.

## Consequences

- Core must collect the Scrape ids it is about to remove before the delete, both for R2 cleanup and for the cascade impact count; the database will not report them.
- D1 runs every query inside an implicit transaction where `PRAGMA foreign_keys=OFF` is a no-op. drizzle-kit's "recreate table" migration (any change SQLite cannot do in place) wraps `DROP TABLE` in that pragma, so on a cascade parent it silently deletes every child row. Schema changes to `brands`, `products`, `retailers`, `listings`, `pages` or `scrapes` are therefore add-column-only, or the generated migration is rewritten by hand before it is committed.
- Until the first production deploy, migrations are regenerated rather than appended, so the initial migration is the one that first reaches D1.
- The previous app's ADR 0005 (synthetic composite keys) is superseded: uniqueness is native multi-column indexes.
