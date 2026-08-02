# Tutorial 2 — fixing a date filter an index cannot help

**Time:** about five minutes. **You need:** SQLSage. A PostgreSQL database only for
the optional measurement at the end.

This tutorial is really about one thing: **adding the index is not the fix.** On this
query the index alone buys nothing at all, and only the index *and* the rewrite
together are worth anything.

## Run it

```bash
sqlsage analyze --corpus q01
```

## The query

```sql
SELECT c.country_code, count(*) AS order_count, sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC;
```

"Revenue by country for March 2024." The `date_trunc` reads as the obvious way to
express "that month".

## What SQLSage says

```text
Function on the filtered column blocks a raw-column search.
date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01' compares a computed
value instead of bare orders.created_at, so an ordinary B-tree on the raw column
cannot directly narrow it.
```

An index stores `created_at`. The query never asks about `created_at` — it asks about
`date_trunc('month', created_at)`, a different value the index knows nothing about. So
the planner scans the table.

Note what SQLSage recommends. Not "create an index", but a single **coupled** step:

```text
Do this first
 1. **Filter the raw timestamp with a half-open month range and create
    idx_sqlsage_orders_btree_status_created_at_include_tot_d99f6d55**
    *(coupled rewrite + index · same results)*
```

The rewrite compares the bare column against a range instead:

```sql
WHERE ("o"."created_at" >= TIMESTAMPTZ '2024-03-01'
   AND "o"."created_at" <  TIMESTAMPTZ '2024-04-01')
  AND o.status = 'complete'
```

Half-open — `>= March 1` and `< April 1` — so it needs no assumption about timestamp
precision and cannot drop a row at 23:59:59.999.

This one is labelled **`same results`**, unlike Tutorial 1's rewrite. Same rows, same
aggregates, different plan.

## Measuring it yourself

Everything below was measured on the reference database: 2,000,000 orders, PostgreSQL
16.14, median of three runs after a warm-up.

```
A  baseline, original query, no new index      111.5 ms
B  index created, query left unchanged         105.3 ms   <- no better
C  index created AND query rewritten            20.4 ms   <- 5.5x faster
```

**B is the point of this tutorial.** With the index sitting right there, PostgreSQL
still refuses it, because `date_trunc()` hides the column:

```
->  Parallel Seq Scan on orders o
      Filter: ((status = 'complete') AND (date_trunc('month', created_at) = '2024-03-01'))
```

Only after the rewrite does the index get used at all:

```
->  Parallel Index Only Scan using idx_probe on orders o (actual rows=24218 loops=2)
```

Anyone who applies step 1 as "create the index", sees no improvement, and concludes
indexing does not help here would have drawn exactly the wrong lesson. This is why
SQLSage renders the pair as one step rather than two.

To reproduce it, run the experiment inside a transaction you roll back, so no index
survives:

```bash
psql "$DATABASE_URL" <<'SQL'
BEGIN;
CREATE INDEX idx_probe ON shop.orders (status, created_at)
  INCLUDE (total_cents, customer_id);
EXPLAIN (ANALYZE, COSTS OFF) <your rewritten query>;
ROLLBACK;
SQL
```

`CREATE INDEX CONCURRENTLY`, which SQLSage emits for real deployment, cannot run
inside a transaction block — SQLSage says so in the report. Use the plain form for a
throwaway experiment like this one, and `CONCURRENTLY` when you deploy for real.

## Why the index has that shape

```sql
CREATE INDEX CONCURRENTLY ... ON "shop"."orders" ("status", "created_at")
  INCLUDE ("total_cents", "customer_id");
```

- `status` leads because it is an equality predicate; a range key cannot be followed by
  further useful keys.
- `created_at` follows as the bounded range.
- `total_cents` and `customer_id` are `INCLUDE`d so the scan can answer from the index
  alone — that is the `Index Only Scan` above.

## Next

- Tutorial 3 analyzes a plan captured from your own database:
  [03-real-explain-plan.md](03-real-explain-plan.md)
- Check a connection before pointing SQLSage at it:
  ```bash
  sqlsage doctor --database-url "$DATABASE_URL" --schema-name public
  ```
