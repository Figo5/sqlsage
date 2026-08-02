# Tutorial 3 — analyzing a real plan from your own database

**Time:** about ten minutes. **You need:** SQLSage and a PostgreSQL database you can
read.

Tutorials 1 and 2 used a bundled example. This one uses your schema, your data and a
plan PostgreSQL actually produced — which is the only way SQLSage can tell you what
*happened* rather than what it predicts.

## 1. Check the connection first

```bash
sqlsage doctor --database-url "$DATABASE_URL" --schema-name public
```

`doctor` is read-only. It never runs your query, and it refuses `--analyze`. It checks
the server version, authentication, whether `EXPLAIN` works inside a read-only
transaction, schema visibility, table read permission, and whether planner statistics
exist. Every failure prints the exact command that fixes it.

Planner statistics are worth noticing: without them, index and cardinality advice is
guesswork.

## 2. Export your schema

```bash
pg_dump "$DATABASE_URL" --schema-only --schema=public > schema.sql
sqlsage doctor --schema schema.sql
```

A real `pg_dump` works as-is. SQLSage skips what carries no schema meaning — the `SET`
preamble, `\restrict` markers, ownership, grants, comments, sequences, extensions, enum
types, and function bodies — and parses what does. Anything it does not recognise fails
loudly rather than being silently dropped, because a catalog quietly missing an index
or a unique constraint would make every later claim unreliable.

If you would rather not hand over DDL, `--catalog` accepts SQLSage's own JSON instead.

## 3. Capture a plan

Save your query, then capture what PostgreSQL does with it:

```bash
cat > slow.sql <<'SQL'
SELECT c.country_code, count(*) AS order_count, sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC
SQL

psql "$DATABASE_URL" -qAt -c "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) $(cat slow.sql);" > plan.json
```

**`EXPLAIN ANALYZE` executes the query.** For a `SELECT` that usually just costs time,
but on a slow query on a busy server that is a real cost. Drop `ANALYZE` to get the
plan without running anything — you lose actual row counts and timings, and SQLSage
will label the report accordingly rather than pretending otherwise.

```bash
sqlsage doctor --plan plan.json
```

## 4. Analyze

```bash
sqlsage analyze --query slow.sql --schema schema.sql --plan plan.json
```

A raw PostgreSQL plan carries no schema, so pair `--plan` with `--schema` or
`--catalog`. If the query and the plan disagree, SQLSage rejects the pairing rather
than reporting one query's plan under another's name.

## What a measured report adds

**Provenance on every claim.** The report says `saved EXPLAIN ANALYZE`, distinguishing
it from `live EXPLAIN ANALYZE`, `saved plan-only EXPLAIN`, and so on. How far to trust
a number depends on where it came from.

**Observed rather than predicted structure:**

```text
Observed plan shape. orders (o) seq scan ~3,541 rows (Observed in the saved
EXPLAIN ANALYZE: PostgreSQL used seq scan, returning 16,146 row(s)…);
customers (c) index scan via customers_pkey ~1 rows; joins: 1× nested loop.
```

**Where the planner was wrong**, which a plan-only capture cannot tell you:

```text
Row estimate at Seq Scan on orders is likely under-estimated — ...
```

That last one is usually the most valuable line in the report. The planner picks a
shape from its estimates; when an estimate is badly wrong, the shape is wrong as a
consequence, and chasing the shape instead of the estimate wastes the afternoon.
SQLSage ranks these by **total rows misjudged** — `|actual − estimated| × loops` —
because a small per-loop error inside a two-million-iteration nested loop does far more
damage than a large one seen once. A misestimate big enough to explain the whole plan
is called out prominently.

## Doing it without a saved file

If SQLSage may talk to the database directly, it captures the plan itself:

```bash
# plan only; does not execute the query
sqlsage analyze --query slow.sql --database-url "$DATABASE_URL" --schema-name public

# executes the query, inside a read-only transaction
sqlsage analyze --query slow.sql --database-url "$DATABASE_URL" --schema-name public \
  --analyze --statement-timeout 5000
```

Read-only mode prevents writes, but it cannot prevent side effects inside an unfamiliar
user-defined volatile function. Read the query before opting in.

SQLSage never executes a rewrite or index it recommends. Those are yours to run.

## Next

- [Supported constructs](../SUPPORTED.md) — what parses, what is rejected, and what is
  accepted but not modelled
- [Usage and inputs](../USAGE.md) — the full input contract
