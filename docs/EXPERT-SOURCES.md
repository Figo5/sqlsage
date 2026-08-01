# Expert ground truth — starting points for critics

Two kinds of ground truth exist in this repo:

1. **`groundtruth/*.txt` and `*.json`** — real `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)`
   from the live 13.2M-row Postgres 16.14 instance, median of three runs. This is
   authoritative for *this* database. When our output disagrees with it, our output is
   wrong.
2. **Expert-written performance material** — the sources below, plus whatever you find.
   This is authoritative for *reasoning quality*: whether we raise the things a senior
   engineer would raise, in the order they would raise them, with the caveats they
   would attach.

**Seed list, not a reading list.** Pull your own sources for your module. Prefer primary
material — the PostgreSQL docs, the pgsql-hackers archives, Markus Winand, Cybertec,
Citus/Crunchy engineering blogs, pganalyze, Depesz — over listicles. Blog posts age
badly: much popular SQL advice describes planner behavior from 2010.

## Verify every claim against *our* server

The instance is Postgres **16.14**, and it is running:

```bash
docker exec sqlsage-pg psql -U postgres -d sage -c "EXPLAIN (ANALYZE, BUFFERS) <query>"
```

Settings that change the answers: `work_mem=32MB`, `shared_buffers=512MB`,
`random_page_cost=1.1`, `max_parallel_workers_per_gather=2`, `jit=on`.

If a source says "Postgres can't do X" — check. Several widely-repeated claims are
false on 16. One corpus query (q10) exists precisely because the textbook advice about
it is wrong, and the real plan proves it. Claims about Postgres 17/18/19 behavior are
**not** applicable here; we run 16.

## By module

**M1 (IR) / M4 (anti-patterns) — sargability**
- <https://use-the-index-luke.com/sql/where-clause/functions> — functions and casts on the
  indexed column; the half-open range rewrite
- <https://use-the-index-luke.com/sql/where-clause/searching-for-ranges/like-performance-tuning>
  — what LIKE can and cannot use an index for; `text_pattern_ops` under non-C collations
- <https://www.postgresql.org/docs/16/indexes-expressional.html> — expression indexes and
  the immutability requirement (relevant: `timestamptz::date` is *not* immutable)

**M3 (execution analysis) — reading plans**
- <https://www.postgresql.org/docs/16/using-explain.html>
- <https://explain.depesz.com/> — the standard tool; its notion of "exclusive time" is the
  right way to attribute cost to a node
- <https://pganalyze.com/blog> — plan-node-level writeups
- Attribute cost by *actual time* and *buffers*, not by cost units. `rows removed by
  filter` and `loops` are where the truth usually hides.

**M5 (indexes) — column order, covering, partial**
- <https://www.postgresql.org/docs/16/indexes-multicolumn.html> — the precise rule:
  equality constraints on leading columns, plus an inequality on the first column
  without an equality, bound the scanned portion
- <https://www.cybertec-postgresql.com/en/combined-indexes-vs-separate-indexes-in-postgresql/>
- <https://www.postgresql.org/docs/16/indexes-index-only-scans.html> — `INCLUDE` columns
  are payload only: they cannot narrow the scan and cannot satisfy an `ORDER BY`
- <https://www.postgresql.org/docs/16/indexes-partial.html>

**M6 (rewrites) — anti-joins, pagination, top-N**
- <https://boringsql.com/posts/not-in-null/> and
  <https://explainextended.com/2009/09/16/not-in-vs-not-exists-vs-left-join-is-null-postgresql/>
  — `NOT IN` on a nullable column is a *correctness* bug first and a plan problem second;
  PG 16 cannot convert it to an anti-join
- <https://use-the-index-luke.com/no-offset> and
  <https://www.citusdata.com/blog/2016/03/30/five-ways-to-paginate/> — keyset pagination,
  including the row-value form `(a, b) < (?, ?)` and the product constraint that keyset
  cannot jump to an arbitrary page
- <https://www.postgresql.org/docs/16/sql-select.html#SQL-DISTINCT> — `DISTINCT ON`
  semantics and its tie-breaking behavior
- <https://www.postgresql.org/docs/16/indexes-multicolumn.html> — PostgreSQL 16 can
  use a matching multicolumn btree to supply order, but it does **not** have the
  btree skip-scan optimization introduced in PostgreSQL 18. Do not promise that
  `DISTINCT ON` jumps directly from one group to the next on this server.

**M2 (semantics) / M7 (report) — what expert prose looks like**
There is no API for this one. Read several real writeups — Depesz's plan analyses,
Cybertec's case studies, pganalyze's query-of-the-week — and extract *what they lead
with*, how much they hedge, and how they attach evidence to claims. Then judge our
output against that, not against a style guide.
