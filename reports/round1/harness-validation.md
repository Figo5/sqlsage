# Harness validation (run before any module existed)

Establishes that `eval/verify.ts` measures what it claims to, and fixes a reference
data point for q01 that critics can check their own reasoning against.

## q01 — index alone does nothing

```
CREATE INDEX idx_test ON shop.orders(status, created_at)
```

| | median | plan |
|---|---|---|
| baseline | 108.8 ms | Seq Scan on orders, **650,521 rows removed by filter** per worker |
| + index | 113.3 ms | *identical plan* — Seq Scan, same filtering |

**1.04× slower.** The index is never used, because `date_trunc('month', o.created_at)`
wraps the column. This is the concrete refutation of "add an index on the filtered
column" as generic advice.

## q01 — rewrite + covering index

```sql
-- half-open range on the bare column
WHERE o.created_at >= TIMESTAMPTZ '2024-03-01'
  AND o.created_at <  TIMESTAMPTZ '2024-04-01'
  AND o.status = 'complete'
```
```
CREATE INDEX idx_t ON shop.orders(status, created_at) INCLUDE (customer_id, total_cents)
```

| | median | rows | digest |
|---|---|---|---|
| original | 108.8 ms | 5 | `e67a1388eae3c25c` |
| rewritten | 27.6 ms | 5 | `e67a1388eae3c25c` |

**3.94× faster, identical results.** The plan becomes an **Index Only Scan** —
`INCLUDE (customer_id, total_cents)` supplies the join key and the summed column, so the
heap is never touched for the 24k matching rows.

## What this establishes for the critics

1. Rewrite and index are **coupled**. Recommending either alone for q01 is a half answer;
   a module that proposes the index without the rewrite has proposed something that
   measurably makes the query slower.
2. `status` first in the composite key is correct here *despite* being the unselective
   column (85% of rows), because it is the equality predicate and `created_at` is the
   range. Verified, not assumed.
3. Digest equality is a usable equivalence check: same 5 rows, same hash.
