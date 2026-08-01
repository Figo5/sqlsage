# SQLSage — builder brief

You are building one module of a SQL query explainer and optimizer. The bar is
**a senior database performance engineer**: someone who reads an EXPLAIN plan
for a living, knows when the folk wisdom is wrong, and says "I don't know"
instead of guessing.

## Repo layout

```
sqlsage/
  src/types.ts        # SHARED CONTRACTS — read fully; do not edit without saying so
  src/catalog.ts      # Catalog model + introspection + selectivity helpers (use these)
  src/db.ts           # Live DB access: capturePlan(), fingerprintResults(), withClient()
  corpus/queries.ts   # The 12-query judgment corpus
  corpus/catalog.json # Frozen schema + pg_stats fixture — the analyzer's only input
  corpus/schema.sql   # DDL, including which indexes exist at baseline
  groundtruth/*.txt   # REAL EXPLAIN (ANALYZE, BUFFERS, VERBOSE) + median timings
  groundtruth/*.json  # Same, machine-readable, with result fingerprints
  src/<yours>/        # Your module
  eval/               # Harness
```

## Environment

- **Node 24 runs TypeScript directly** — `node src/cli.ts` works, no build step.
  Import with explicit `.ts` extensions: `import { x } from '../types.ts'`.
- Live Postgres 16 on `127.0.0.1:55432`, db `sage`, user `postgres`, password `sage`,
  schema `shop`. Use it freely to check your reasoning:
  ```bash
  docker exec sqlsage-pg psql -U postgres -d sage -c "EXPLAIN (ANALYZE, BUFFERS) SELECT ..."
  ```
- The data is real: 2M orders, 6M order_items, 5M events, 200k customers, 1.6 GB.
  Baseline indexes are **only** the primary keys plus `idx_orders_customer_id` and
  `idx_order_items_order_id`. Everything else must be earned.

## The one rule that matters

**Your module must not special-case the corpus.** No branching on query id, no
matching the exact SQL text, no lookup table keyed by a fingerprint of the input.
The corpus is a *test set*, not a spec. A critic reads your source specifically
looking for this, and finding it is a failing grade regardless of output quality.

Write general analysis over the IR and the catalog. If your rule only fires on
one shape, that is fine — but it must fire on *that shape anywhere*, and it must
correctly stay silent on shapes it does not understand.

## Quality bar, concretely

1. **Grounded in the catalog, not vibes.** "This filter is unselective" is worth
   nothing. "`status = 'complete'` matches 85% of 2M rows (pg_stats MCV frequency
   0.85), but it still belongs before the `created_at` range in a composite btree:
   equality on the leading key lets PostgreSQL bound the scan before applying the
   range" is the bar. This ordering was verified against q01's live plan.
2. **Right about modern Postgres.** Much SQL advice on the internet is 15 years
   stale. PG 16 pushes many predicates you were told it wouldn't, uses incremental
   sort, and hashes anti-joins. Check against the real planner before asserting.
3. **Calibrated.** Every output carries a confidence. Say "no useful index exists
   for this predicate" when true. Silence beats a confident wrong answer — one
   corpus query is a deliberate trap where the textbook advice is simply wrong.
4. **Correctness outranks speed.** Three corpus queries return *wrong answers*.
   A module that optimizes a query without noticing it is already broken has
   failed at the job.
5. **Caveated.** Where a claim depends on an assumption (uniqueness, NULL-freeness,
   a session setting), say the assumption out loud.

## Deliverable

- Your module under `src/<name>/`, exporting the function named in your prompt.
- It must run: `node -e "import('./src/<name>/index.ts').then(...)"` over all 12
  corpus queries without throwing.
- A short `src/<name>/NOTES.md`: your approach, what you deliberately do NOT
  handle, and where you think you are weakest. Critics reward honesty here and
  punish overclaiming.
- Do not edit other modules' directories. Do not edit `src/types.ts` without
  flagging it prominently in your final message.
