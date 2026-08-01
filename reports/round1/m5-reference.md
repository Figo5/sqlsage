# M5 Round 1 blind reference — index recommender

**Protocol state:** Phase 1 only. This reference was written before any M5 output or
source was available. I did not inspect `src/indexes/`, builder reasoning, or a future
M6 implementation. No comparison, score, or verdict belongs in this file.

**Target:** PostgreSQL 16.14, database collation `en_US.utf8`, session time zone
`Etc/UTC`, `work_mem=32MB`, `random_page_cost=1.1`. The live catalog contains only
the eight intended baseline indexes: six primary keys,
`idx_orders_customer_id`, and `idx_order_items_order_id`.

## What “ideal” means for M5

An index recommendation is not just syntactically valid DDL. It must:

1. make the relevant predicate, join, or order materially cheaper on this catalog;
2. put equality keys before the first range key, and keep ordering columns as keys
   rather than pretending an `INCLUDE` column can order or narrow a scan;
3. say when a rewrite is a prerequisite instead of claiming an unused index is a fix;
4. account for index size and write amplification, including payload-column bloat;
5. decline to recommend an index when correctness, intent, selectivity, or an already
   fast plan makes the index unjustified; and
6. expose a stable definition-based `id` for any future
   `Rewrite.requiresIndexes` reference.

The arrays below are the per-query ideal. “Conditional” means M5 may return the
object, but its prose must make the gate unmistakable. It must never describe a
conditional index as fixing the current SQL by itself. Production DDL uses
`CONCURRENTLY`; the verification harness removed that keyword so each build could
run inside a transaction and roll back.

## Portfolio-level consolidation

Per-query analysis can legitimately produce overlapping indexes. A senior engineer
does one more pass before deployment:

| Physical definition | Queries | Portfolio decision |
|---|---|---|
| `customers(signup_date DESC)` | q02, q07 | Build once; use stable id `idx-customers-signup-date-desc`. |
| `orders(customer_id, created_at DESC) INCLUDE (order_id, total_cents)` | q03, q11 | Build once for q11; q03 gets a secondary benefit. |
| `orders(status, created_at) INCLUDE (customer_id, total_cents)` | q01 | Do not build if the broader q04 index below will be deployed. |
| `orders(status, created_at DESC, order_id DESC) INCLUDE (customer_id, total_cents)` | q01, q04 | Prefer this broader definition when both q01 and q04 are in the workload; it also gave q01 a measured 3.97x speedup after the range rewrite. |

The two existing `orders` indexes with leading `customer_id` overlap some proposed
definitions, but the existing 19 MB index is much narrower. Do not automatically drop
it just because a wider covering index has the same leading key; validate the whole
workload first.

---

## q01 — non-sargable `date_trunc`

### Evidence and decision

The baseline parallel sequential scan removes 650,521 rows per worker. An index on
the raw columns is unusable while `date_trunc('month', created_at)` remains in the
predicate. The already-verified result is decisive: the index alone changed no plan
and was 1.04x slower; a half-open raw-column range plus the covering index changed the
orders access to an index-only scan and ran about 3.94x faster with an identical
digest.

`status` remains first even though `'complete'` covers about 85% of orders. It is the
equality key; `created_at` is the range key. Reversing them would make the status
condition unable to narrow the scanned portion after the range begins.

### Ideal `IndexRecommendation[]`

```ts
[
  {
    id: 'idx-orders-status-created-cover',
    ddl: "CREATE INDEX CONCURRENTLY idx_sqlsage_orders_status_created_cover ON shop.orders (status, created_at) INCLUDE (customer_id, total_cents);",
    table: 'orders',
    columns: ['status', 'created_at'],
    includeColumns: ['customer_id', 'total_cents'],
    method: 'btree',
    columnOrderRationale: "status is constrained by equality and therefore leads; created_at is the first range key. customer_id and total_cents are payload only for the join and aggregate.",
    serves: [
      "The M6 half-open predicate created_at >= :month_start AND created_at < :next_month_start together with status = 'complete'",
      'The customer join and revenue aggregate through an index-only orders access when visibility permits',
    ],
    expectedEffect: "No useful effect on q01 as written. With the half-open range rewrite, replace the parallel orders Seq Scan with an Index Only Scan; measured about 111 ms to 28 ms with identical rows. The index must be presented as rewrite-coupled.",
    cost: {
      estimatedSizeNote: 'Measured at about 110 MB on 2.0M orders.',
      writeImpact: 'Maintained on every order insert and on updates to status, created_at, customer_id, or total_cents; INCLUDE payload prevents btree deduplication and materially widens the index.',
    },
    redundantWith: ['idx_sqlsage_orders_status_created_order_cover when the q04 workload index is deployed'],
    priority: 1,
    confidence: 'high',
  },
]
```

**M6 dependency contract:** the half-open-range rewrite should reference
`idx-orders-status-created-cover`; a workload-level deduplicator may substitute the
broader q04 id. The rewrite must state the intended time zone for month boundaries.

---

## q02 — leading wildcard plus cross-column `OR`

### Evidence and decision

This literal is a selectivity trap. All 200,000 customers match
`email LIKE '%@example.com'`; 111,111 also match the name prefix, so the whole `OR`
matches the table. A transactional test created both a `pg_trgm` GIN index on email
and a `text_pattern_ops` btree on full name. PostgreSQL still chose the parallel
sequential scan and ran 24.7 ms versus 24.1 ms: neither filter index earned its write
cost.

The useful path for this exact query is order-driven, not filter-driven. A small
btree on `signup_date` lets PostgreSQL read newest rows and stop after 50. It changed
the plan from scanning and top-N sorting 200,000 rows to an index scan that visited
50 rows, about 24 ms to roughly 0.1 ms. The benefit is parameter-sensitive: if future
patterns are sparse, the index may have to walk many entries before finding 50.

### Ideal `IndexRecommendation[]`

```ts
[
  {
    id: 'idx-customers-signup-date-desc',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_customers_signup_date_desc ON shop.customers (signup_date DESC);',
    table: 'customers',
    columns: ['signup_date DESC'],
    method: 'btree',
    columnOrderRationale: 'The single key matches ORDER BY signup_date DESC. A btree can be scanned in either direction; spelling DESC documents the intended top-N path.',
    serves: ['ORDER BY signup_date DESC LIMIT 50 by permitting an early-stop ordered scan'],
    expectedEffect: 'For the measured literals, replace the parallel Seq Scan plus top-N sort with an Index Scan that stops after 50 rows; measured roughly 24 ms to 0.1 ms. It does not make either LIKE predicate indexable.',
    cost: {
      estimatedSizeNote: 'Measured at about 1.35 MB on 200k customers.',
      writeImpact: 'One narrow date-key entry per customer; maintained on inserts and signup_date updates.',
    },
    priority: 2,
    confidence: 'medium',
  },
]
```

### Rejected for the current literals; valid only for a different search workload

If representative parameters are selective, email infix search needs `pg_trgm`,
while the anchored full-name branch needs the pattern operator class under this
non-C collation:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX CONCURRENTLY idx_sqlsage_customers_email_trgm
    ON shop.customers USING gin (email gin_trgm_ops);
CREATE INDEX CONCURRENTLY idx_sqlsage_customers_full_name_pattern
    ON shop.customers USING btree (full_name text_pattern_ops);
```

Those two definitions are deliberately **not** in the active array. With selective
values PostgreSQL can potentially combine them with `BitmapOr`, or M6 can split the
branches. A `UNION ALL` split is not generally equivalent because a customer matching
both branches would be duplicated; `UNION` or explicit overlap elimination is needed.
Neither filter design supplies the unrelated `signup_date` order.

---

## q03 — correlated counts and maxima, but already fast

### Evidence and decision

The alarming SQL shape is well served by the existing customer-id index because only
2,000 gold customers are selected and each has about ten orders. Baseline is about
31 ms, not a crisis. A 120 kB partial covering index for gold customers is cheap and
cut the query to about 17 ms. The broader q11 workload index lets `max(created_at)`
use a one-row index probe; alone it cut about 32 ms to 21 ms, and the pair measured
about 30 ms to 7.5 ms. The latter still saves only tens of milliseconds and is 95 MB,
so q03 alone does not justify it at high priority.

### Ideal `IndexRecommendation[]`

```ts
[
  {
    id: 'idx-customers-gold-customer-cover',
    ddl: "CREATE INDEX CONCURRENTLY idx_sqlsage_customers_gold_customer_cover ON shop.customers (customer_id) INCLUDE (email) WHERE loyalty_tier = 'gold';",
    table: 'customers',
    columns: ['customer_id'],
    includeColumns: ['email'],
    method: 'btree',
    where: "loyalty_tier = 'gold'",
    columnOrderRationale: 'The partial predicate performs the tier restriction; customer_id is the compact key needed for correlation and email is output-only payload.',
    serves: ["The fixed loyalty_tier = 'gold' driver scan", 'customer_id and email retrieval without visiting the heap when visibility permits'],
    expectedEffect: 'Replace the 200k-row customers Seq Scan with a 2,000-entry partial Index Only Scan; measured about 31 ms to 17 ms by itself.',
    cost: {
      estimatedSizeNote: 'Measured at about 120 kB because gold is about 1% of customers.',
      writeImpact: 'Maintained only for gold rows, plus updates that enter or leave the gold predicate; includes email payload.',
    },
    priority: 3,
    confidence: 'high',
  },
  {
    id: 'idx-orders-customer-created-desc-cover',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_orders_customer_created_desc_cover ON shop.orders (customer_id, created_at DESC) INCLUDE (order_id, total_cents);',
    table: 'orders',
    columns: ['customer_id', 'created_at DESC'],
    includeColumns: ['order_id', 'total_cents'],
    method: 'btree',
    columnOrderRationale: 'customer_id is the correlated equality key; created_at DESC makes max(created_at) a one-row probe. The payload is present for the shared q11 top-per-group path, not to narrow q03.',
    serves: ['Both q03 correlated subqueries', 'The q11 rewritten top-per-customer ordering'],
    expectedEffect: 'On q03, turn the max subplan into Limit plus a one-row Index Only Scan and keep count index-only; measured about 32 ms to 21 ms alone. This is a low-priority q03 recommendation but a high-priority shared q11 index.',
    cost: {
      estimatedSizeNote: 'Measured at about 95 MB on 2.0M orders.',
      writeImpact: 'Maintained on every order insert and on changes to all four stored columns; wide enough that the existing narrow customer_id index should not be dropped without workload testing.',
    },
    priority: 3,
    confidence: 'high',
  },
]
```

An expert must calibrate this as “already fast; optional if frequent,” not repeat the
folk claim that correlated syntax is automatically disastrous. A rewrite that scans
and groups all 2M orders could be slower than the current 4,000 small probes.

---

## q04 — deep offset pagination

### Evidence and decision

The baseline scans 1.7M complete orders, joins them, sorts, produces 100,020 rows,
then discards 100,000. The index must carry both order keys as keys in the same order;
`order_id` cannot be an `INCLUDE` column because it is part of both the row-value seek
predicate and deterministic sort.

The index alone improved the still-wasteful OFFSET query from about 526 ms to 172 ms.
With the keyset boundary `(created_at, order_id) < (:created_at, :order_id)`, the live
test returned the same 20-row digest in about 0.1 ms versus 381 ms, using a 20-row
index-only orders scan.

### Ideal `IndexRecommendation[]`

```ts
[
  {
    id: 'idx-orders-status-created-order-cover',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_orders_status_created_order_cover ON shop.orders (status, created_at DESC, order_id DESC) INCLUDE (customer_id, total_cents);',
    table: 'orders',
    columns: ['status', 'created_at DESC', 'order_id DESC'],
    includeColumns: ['customer_id', 'total_cents'],
    method: 'btree',
    columnOrderRationale: 'status is the equality prefix; created_at and order_id then exactly match the descending row-value boundary and ORDER BY. customer_id and total_cents are payload only.',
    serves: [
      "status = 'complete' with ORDER BY created_at DESC, order_id DESC",
      'The M6 keyset predicate (created_at, order_id) < (:created_at, :order_id)',
      'q01 after its half-open date rewrite',
    ],
    expectedEffect: 'As written, replace the full scan/hash join/sort with an ordered index-only orders scan but still visit 100,020 entries; measured about 3.05x faster. With keyset pagination, visit only 20 orders and avoid the sort; measured digest-identical and over three orders of magnitude faster on this deep page.',
    cost: {
      estimatedSizeNote: 'Measured at about 127 MB on 2.0M orders.',
      writeImpact: 'Maintained on every order insert and updates to all five stored columns; this is a deliberately workload-specific covering index.',
    },
    supersedes: ['idx_sqlsage_orders_status_created_cover if both q01 and q04 indexes were otherwise planned'],
    priority: 1,
    confidence: 'high',
  },
]
```

**M6 dependency contract:** the keyset rewrite should require
`idx-orders-status-created-order-cover`. It must also state that keyset pagination
cannot jump to an arbitrary page number and requires a cursor from the previous page.

---

## q05 — nullable `NOT IN`

### Evidence and decision

Correctness is the gate. The current query returns zero rows because the checkout
subquery contains NULL customer ids. No index can repair that result. After M6 changes
the query to correlated `NOT EXISTS`, a tiny partial index is excellent: it contains
only non-null checkout customer ids and can drive a merge anti-join. The live test
returned the intended 196,000 rows and ran about 147 ms to 45 ms. The changed digest
is the correctness fix, not an equivalence failure.

### Ideal `IndexRecommendation[]` — conditional on the correctness rewrite

```ts
[
  {
    id: 'idx-events-checkout-customer-not-null',
    ddl: "CREATE INDEX CONCURRENTLY idx_sqlsage_events_checkout_customer_not_null ON shop.events (customer_id) WHERE event_type = 'checkout' AND customer_id IS NOT NULL;",
    table: 'events',
    columns: ['customer_id'],
    method: 'btree',
    where: "event_type = 'checkout' AND customer_id IS NOT NULL",
    columnOrderRationale: 'The fixed event type and null exclusion belong in the partial predicate; customer_id is the anti-join equality key.',
    serves: ["The M6 NOT EXISTS correlation e.customer_id = c.customer_id with event_type = 'checkout'"],
    expectedEffect: 'Does not fix or accelerate the wrong NOT IN semantics. After the NOT EXISTS rewrite, provide an index-only stream of about 85.7k non-null checkout customers for a merge anti-join; measured about 147 ms to 45 ms while returning the corrected 196k rows.',
    cost: {
      estimatedSizeNote: 'Measured at about 672 kB on 5.0M events.',
      writeImpact: 'Maintained only for non-null checkout events; very low relative write and storage cost.',
    },
    priority: 1,
    confidence: 'high',
  },
]
```

**M6 dependency contract:** `NOT EXISTS` should require
`idx-events-checkout-customer-not-null`. M5 must label the index as secondary to the
correctness repair, never as the repair itself.

---

## q06 — fan-out double counting

### Ideal `IndexRecommendation[]`

```ts
[]
```

This is an explicit no-index answer. The query reports revenue at the wrong grain:
six million item rows multiply 1.7M complete orders and make revenue exactly 3x too
high. A transactional 110 MB index on
`orders(status, customer_id) INCLUDE (order_id, total_cents)` remained unused and
moved only about 2458 ms to 2422 ms (1.01x, noise). `'complete'` is 85% of orders, so
a status-led scan cannot avoid enough work. Existing PK/FK indexes already support
the joins; the expensive unfiltered item scan and aggregation cannot be indexed away.

M6 must first restore one row per order (or separately aggregate item counts at
`order_id` grain). Only the resulting SQL and real workload can justify another
index. Leading with an index here would distract from a wrong-answer defect.

---

## q07 — demoted outer join: intent before tuning

### Evidence and gate

The `WHERE o.status = 'complete'` predicate makes the current `LEFT JOIN` behave as an
inner join. The product owner must choose between:

- true inner semantics, in which case the SQL should say `JOIN`; or
- preserving customers without complete orders, in which case the status predicate
  moves to `ON` and the result grows from 149,000 to 151,500 rows on this data.

The same access-path pair helps either chosen shape, but the recommendation must be
blocked behind that intent decision and must say it does not fix semantics. There is
also a coupling trap: the customer date index by itself was 1.45x slower because it
lost the baseline parallel plan and still performed random order heap probes. With
the covering orders index, the pair measured about 84 ms to 41 ms.

### Ideal `IndexRecommendation[]` — conditional on an explicit intent decision

```ts
[
  {
    id: 'idx-customers-signup-date-desc',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_customers_signup_date_desc ON shop.customers (signup_date DESC);',
    table: 'customers',
    columns: ['signup_date DESC'],
    method: 'btree',
    columnOrderRationale: 'signup_date is the customer-side range key. Direction is immaterial for this range but shares the q02 physical index.',
    serves: ["c.signup_date >= DATE '2024-01-01'", 'The q02 newest-customer top-N order'],
    expectedEffect: 'Use a bitmap scan to find about 17.4k recent customers. Do not deploy it for q07 by itself: measured alone it was slower. It earns its place only as the small shared q02 index or together with the covering orders index below.',
    cost: {
      estimatedSizeNote: 'Measured at about 1.35 MB on 200k customers.',
      writeImpact: 'One narrow date-key entry per customer.',
    },
    priority: 3,
    confidence: 'high',
  },
  {
    id: 'idx-orders-customer-status-cover',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_orders_customer_status_cover ON shop.orders (customer_id, status) INCLUDE (order_id, total_cents);',
    table: 'orders',
    columns: ['customer_id', 'status'],
    includeColumns: ['order_id', 'total_cents'],
    method: 'btree',
    columnOrderRationale: 'customer_id leads because the chosen plan probes orders for each selected customer and preserves the general FK lookup path; status is the second equality key. order_id and total_cents are output payload.',
    serves: ["o.customer_id = c.customer_id AND o.status = 'complete' for either explicit INNER JOIN or status-in-ON LEFT JOIN semantics"],
    expectedEffect: 'Replace 17.4k heap-touching customer_id probes and status filters with covering index-only probes. Measured about 83 ms to 52 ms alone and about 84 ms to 41 ms with the small signup_date index. It does not resolve which join semantics are correct.',
    cost: {
      estimatedSizeNote: 'Measured at about 110 MB on 2.0M orders.',
      writeImpact: 'Maintained on each order and updates to customer_id, status, order_id, or total_cents; significant OLTP write and cache cost.',
    },
    priority: 2,
    confidence: 'high',
  },
]
```

The existing narrow `idx_orders_customer_id` is not automatically superseded; it is
far smaller and remains attractive for customer-only probes.

---

## q08 — `DISTINCT` hiding a fan-out

### Evidence and decision

The dominant access-path failure is not the 50k-row products scan; it is scanning all
6M order items to find the roughly 30k items belonging to 250 products in category
42. A product-led index on `order_items.product_id` changes the join order and avoids
that scan. `order_id` is payload, not a search or ordering key. The product category
index is cheap but secondary.

The order-items index alone measured about 300 ms to 95 ms. Adding the small product
index moved about 297 ms to 89 ms. PostgreSQL also changed the duplicate-removal shape
to a hash aggregate, but the query still does unnecessary fan-out work; M6's `EXISTS`
rewrite remains valuable.

### Ideal `IndexRecommendation[]`

```ts
[
  {
    id: 'idx-order-items-product-cover',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_order_items_product_cover ON shop.order_items (product_id) INCLUDE (order_id);',
    table: 'order_items',
    columns: ['product_id'],
    includeColumns: ['order_id'],
    method: 'btree',
    columnOrderRationale: 'product_id is the equality probe from the selective category products; order_id is payload passed to the orders lookup and need not enlarge the search key.',
    serves: ['p.product_id = oi.product_id from the category-led path', 'The equivalent join path inside an M6 EXISTS semi-join'],
    expectedEffect: 'Replace the 6M-row parallel order_items Seq Scan with about 250 small index-only product probes returning roughly 30k order ids; measured about 3.15x faster by itself.',
    cost: {
      estimatedSizeNote: 'Measured at about 181 MB on 6.0M order items.',
      writeImpact: 'A substantial index on the highest-row-count OLTP child table; maintained on each item insert and product/order reassignment.',
    },
    priority: 1,
    confidence: 'high',
  },
  {
    id: 'idx-products-category-cover',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_products_category_cover ON shop.products (category_id) INCLUDE (product_id);',
    table: 'products',
    columns: ['category_id'],
    includeColumns: ['product_id'],
    method: 'btree',
    columnOrderRationale: 'category_id is the 0.5%-selective equality key; product_id is payload for the order_items probe.',
    serves: ['p.category_id = 42 and product_id retrieval'],
    expectedEffect: 'Replace a roughly 2.4 ms products Seq Scan with a 250-row index-only scan. Combined with the order_items index, total runtime measured about 297 ms to 89 ms; most of that gain belongs to the order_items index.',
    cost: {
      estimatedSizeNote: 'Measured at about 1.55 MB on 50k products.',
      writeImpact: 'Low absolute storage and maintenance cost, but still optional because the table scan is already cheap.',
    },
    priority: 3,
    confidence: 'high',
  },
]
```

Do not recommend an orders `created_at` index for this literal path: almost all of the
30k candidate item orders pass the date condition, and primary-key order lookups are
already selective.

---

## q09 — `timestamptz::date` and immutability

### Evidence and decision

`created_at::date` depends on the session `TimeZone`, so PostgreSQL rejects the
tempting expression index with `functions in index expression must be marked
IMMUTABLE`. M5 must not emit invalid DDL. The default repair is an M6 half-open range
on raw `created_at`, with explicit time-zone semantics.

The table's `created_at` correlation is 1.0. A BRIN index with 32 pages per range was
only about 40 kB and changed the rewritten query from about 74 ms to 13.4 ms via a
lossy bitmap heap scan. A plain btree was slightly faster at about 11 ms but measured
43 MB. The BRIN is the better default cost/effect trade-off for this append-correlated
range workload; choose the btree instead only when the extra ~2 ms matters enough to
pay the storage and write cost.

### Ideal `IndexRecommendation[]`

```ts
[
  {
    id: 'idx-orders-created-at-brin',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_orders_created_at_brin ON shop.orders USING brin (created_at) WITH (pages_per_range = 32, autosummarize = on);',
    table: 'orders',
    columns: ['created_at'],
    method: 'brin',
    columnOrderRationale: 'A single physically correlated timestamp range key; pages_per_range 32 trades a still-tiny index for more precise block elimination.',
    serves: ['The M6 raw half-open created_at range for June 2024 and similar time windows'],
    expectedEffect: 'No useful effect while the WHERE clause casts created_at. After the raw-column rewrite, replace the 2M-row parallel Seq Scan with a BRIN-driven bitmap heap scan over the matching physical ranges; measured about 74 ms to 13.4 ms with identical results under UTC.',
    cost: {
      estimatedSizeNote: 'Measured at about 40 kB, versus about 43 MB for the tested btree alternative.',
      writeImpact: 'Very low per-row cost, but BRIN effectiveness depends on preserving physical/time correlation; autosummarize still relies on autovacuum activity.',
    },
    priority: 1,
    confidence: 'high',
  },
]
```

The low-latency alternative, mutually exclusive with the BRIN unless both are proven
useful across a larger workload, is:

```sql
CREATE INDEX CONCURRENTLY idx_sqlsage_orders_created_at
    ON shop.orders (created_at);
```

If product semantics require “UTC calendar date” and the SQL must retain an expression,
this immutable alternative is valid only with an exact matching query expression:

```sql
CREATE INDEX CONCURRENTLY idx_sqlsage_orders_created_date_utc
    ON shop.orders (((created_at AT TIME ZONE 'UTC')::date));
```

That changes the semantic contract from session-local date to UTC date. It must never
be suggested as silently equivalent to `created_at::date` in every session.

**M6 dependency contract:** the raw-range rewrite should require
`idx-orders-created-at-brin` (or explicitly choose the btree alternative) and state
the intended zone for the June 1 / July 1 instants.

---

## q10 — grouping-key predicate in `HAVING`

### Ideal `IndexRecommendation[]`

```ts
[]
```

This is the deliberate false-positive trap. PostgreSQL 16 already pushes
`customer_id < 1000` into a bitmap scan on `idx_orders_customer_id`, reads 9,990 of
2M orders, and finishes in about 6.9 ms. `count(*) > 5` correctly remains above the
aggregate. Moving the grouping-key condition to `WHERE` is a readability change with
the same access path, not a reason to add an index. A wide covering replacement to
save a few cached heap visits is not justified by this already-fast query without
strong frequency evidence.

---

## q11 — top row per group on PostgreSQL 16

### Evidence and decision

The baseline executes the max subplan two million times, touches roughly 28M buffers,
and runs about 6.6 seconds. The composite index alone makes each max lookup a one-row
probe and makes the outer scan covering, but the current correlated form still invokes
two million subplans: measured about 6.8 seconds to 2.1 seconds, still unacceptable.

With a semantics-approved `DISTINCT ON` form, the same index supplies
`customer_id, created_at DESC` order and covers the result. The live test returned the
same digest on this tie-free seed and ran about 264 ms, a 24x improvement. Crucially,
PostgreSQL 16 scanned all 2M index entries and then emitted 200k groups. Btree skip
scan arrived in PostgreSQL 18; M5 must not promise one probe per customer on this
server.

### Ideal `IndexRecommendation[]` — rewrite-coupled for the full benefit

```ts
[
  {
    id: 'idx-orders-customer-created-desc-cover',
    ddl: 'CREATE INDEX CONCURRENTLY idx_sqlsage_orders_customer_created_desc_cover ON shop.orders (customer_id, created_at DESC) INCLUDE (order_id, total_cents);',
    table: 'orders',
    columns: ['customer_id', 'created_at DESC'],
    includeColumns: ['order_id', 'total_cents'],
    method: 'btree',
    columnOrderRationale: 'customer_id groups adjacent entries; created_at DESC puts newest first inside each group and supplies the rewritten order. order_id and total_cents are result payload, not ordering keys.',
    serves: ['A DISTINCT ON/window/rank rewrite ordered by customer_id, created_at DESC', 'The current max subplan as a one-row lookup', 'q03 max(created_at) probes'],
    expectedEffect: 'Alone, reduce inner work but leave 2M correlated invocations (measured about 6.8 s to 2.1 s). With the rewritten top-per-group form, avoid the separate sort and heap reads; measured about 264 ms and an index-only scan of all 2M entries. PostgreSQL 16 does not skip directly between the 200k groups.',
    cost: {
      estimatedSizeNote: 'Measured at about 95 MB on 2.0M orders.',
      writeImpact: 'Maintained on every order insert and changes to all stored columns; overlaps the existing narrow customer_id index but does not automatically make it safe to drop.',
    },
    priority: 1,
    confidence: 'high',
  },
]
```

**Semantic gate for M6:** the original returns every row tied at the maximum timestamp.
Plain `DISTINCT ON` or `row_number() = 1` chooses one and is not generally equivalent.
Use `rank() = 1` or a grouped-max join to preserve ties, or explicitly require a
single-row product contract and add a deterministic tie-breaker. The index cannot
settle that decision.

---

## q12 — JSON extraction, event type, and time range

### Evidence and decision

A generic GIN index on `payload jsonb_path_ops` is the wrong operator/path for the SQL
as written: `payload ->> 'utm_source' = 'email'` is text equality, not a supported
whole-json containment predicate. The transactional GIN test remained unused and
moved only 188 ms to 185 ms (1.02x noise). It also cannot combine the event type and
time range into ordered btree bounds or provide an index-only result.

The exact event-type set is stable in this query and covers about 10% of events, so a
partial expression btree is much smaller than indexing all 5M rows. The partial
predicate removes `event_type` from the key; expression equality leads and the
timestamp range follows. The measured 20 MB index changed about 211 ms to 67 ms. A
full composite btree on `(event_type, (payload->>'utm_source'), occurred_at)` also
worked but was slower in the test (about 87 ms) and indexes every event.

### Ideal `IndexRecommendation[]`

```ts
[
  {
    id: 'idx-events-funnel-utm-occurred-cover',
    ddl: "CREATE INDEX CONCURRENTLY idx_sqlsage_events_funnel_utm_occurred_cover ON shop.events ((payload ->> 'utm_source'), occurred_at) INCLUDE (customer_id) WHERE event_type IN ('add_to_cart', 'checkout');",
    table: 'events',
    columns: ["(payload ->> 'utm_source')", 'occurred_at'],
    includeColumns: ['customer_id'],
    method: 'btree',
    where: "event_type IN ('add_to_cart', 'checkout')",
    columnOrderRationale: 'The partial predicate removes the fixed event-type set from the index key; utm_source text equality leads, followed by the occurred_at range. customer_id is payload for count(DISTINCT), not a scan bound.',
    serves: ["payload ->> 'utm_source' = 'email'", "event_type IN ('add_to_cart', 'checkout')", "occurred_at >= TIMESTAMPTZ '2024-06-01'"],
    expectedEffect: 'Replace the 5M-row parallel events Seq Scan with a bounded expression-index scan over about 111.6k rows; measured about 211 ms to 67 ms. The distinct-customer sort/aggregate remains real work.',
    cost: {
      estimatedSizeNote: 'Measured at about 20 MB because only the two funnel event types are indexed.',
      writeImpact: 'Maintained only for matching event types, but computes the JSON text expression and stores customer_id for each such insert/update.',
    },
    priority: 1,
    confidence: 'high',
  },
]
```

If event-type sets are parameterized rather than fixed, the partial predicate may not
be provable at plan time. In that workload use the broader composite btree instead
and accept its higher maintenance cost. A generic payload GIN becomes appropriate
only for a broad family of containment/jsonpath queries and a matching predicate such
as `payload @> '{"utm_source":"email"}'`; it is not the default answer for one known
scalar key.

---

## Rewrite/index dependency map for future M6

This is a conceptual interface only; no M6 implementation was inspected.

| Query | Rewrite concept | Stable index id(s) the rewrite may require |
|---|---|---|
| q01 | Raw half-open month range with explicit zone | `idx-orders-status-created-cover` (or portfolio-substituted q04 index) |
| q04 | Row-value keyset cursor matching both DESC sort keys | `idx-orders-status-created-order-cover` |
| q05 | Null-safe correlated `NOT EXISTS` | `idx-events-checkout-customer-not-null` |
| q07 | Explicit inner join or status predicate moved into `ON`, after intent decision | `idx-orders-customer-status-cover`; optionally shared `idx-customers-signup-date-desc` |
| q08 | `EXISTS`/semi-join that retains the category-led path | `idx-order-items-product-cover`; optionally `idx-products-category-cover` |
| q09 | Raw half-open timestamp range with explicit zone | `idx-orders-created-at-brin` or an explicitly selected btree alternative |
| q11 | Tie-aware top-per-group rewrite | `idx-orders-customer-created-desc-cover` |

## Transactional verification summary

All index builds below ran inside transactions and were rolled back. Timings vary with
cache state; plan shape, rows, digest, index use, and order-of-magnitude effect are the
authoritative evidence.

| Query/test | Baseline | Candidate | Result |
|---|---:|---:|---|
| q01 index alone (prior validated run) | 108.8 ms | 113.3 ms | Unused; 1.04x slower. |
| q01 range rewrite + q04 superset index | 116.0 ms | 29.2 ms | 3.97x, identical digest, index-only orders scan. |
| q02 trigram + pattern indexes | 24.7 ms | 24.1 ms | Both unused because OR matches all rows. |
| q02 signup-date order index | 24.1 ms | ~0.1 ms | Reads 50 index entries; no sort. |
| q03 customer partial only | 31.4 ms | 17.1 ms | Partial index-only customer scan. |
| q03 order composite only | 31.9 ms | 20.5 ms | One-row max probe. |
| q03 both | 29.7 ms | 7.5 ms | About 3.98x, but small absolute saving. |
| q04 index with OFFSET | 525.5 ms | 172.3 ms | 3.05x; still reads 100,020 entries. |
| q04 keyset + index | 380.5 ms | ~0.1 ms | Same 20-row digest; reads 20 entries. |
| q05 NOT EXISTS + partial index | 147.4 ms wrong/0 rows | 44.6 ms correct/196k rows | Correctness fix plus merge anti-join. |
| q06 status covering index | 2457.7 ms | 2421.7 ms | Unused; 1.01x noise. |
| q07 customer date index alone | 96.7 ms | 140.2 ms | Harmful alone. |
| q07 orders covering index alone | 83.1 ms | 51.8 ms | 1.60x. |
| q07 shared date + orders cover | 84.5 ms | 40.6 ms | 2.08x. |
| q08 order-items index alone | 300.3 ms | 95.3 ms | 3.15x. |
| q08 both indexes | 296.5 ms | 88.9 ms | 3.34x. |
| q09 raw range + btree | 74.3 ms | 11.0 ms | 6.77x, 43 MB index. |
| q09 raw range + BRIN | 74.4 ms | 13.4 ms | 5.56x, 40 kB index. |
| q11 index only, original SQL | 6805.6 ms | 2097.6 ms | Still 2M subplans. |
| q11 DISTINCT ON + index | 6332.7 ms | 263.9 ms | 24x; scans all 2M index entries on PG16. |
| q12 partial expression btree | 210.8 ms | 67.3 ms | 3.13x, 20 MB. |
| q12 generic payload GIN | 188.1 ms | 185.0 ms | Unused; wrong operator shape. |

Measured candidate sizes were obtained with `pg_relation_size` before rollback. After
all tests, the live database again had exactly eight `shop` indexes, only `plpgsql`
installed, and zero invalid/not-ready indexes.

## Primary sources checked

- PostgreSQL 16, [multicolumn indexes](https://www.postgresql.org/docs/16/indexes-multicolumn.html): leading equalities plus the first range determine the bounded scan.
- PostgreSQL 16, [indexes and ORDER BY](https://www.postgresql.org/docs/16/indexes-ordering.html): btree ordering and the especially important `ORDER BY ... LIMIT` early-stop case.
- PostgreSQL 16, [index-only scans and covering indexes](https://www.postgresql.org/docs/16/indexes-index-only-scans.html): visibility-map caveat, payload behavior, and expression-index planner limitations.
- PostgreSQL 16, [partial indexes](https://www.postgresql.org/docs/16/indexes-partial.html): the query must imply the predicate at plan time; parameterized clauses often cannot.
- PostgreSQL 16, [operator classes](https://www.postgresql.org/docs/16/indexes-opclass.html): `text_pattern_ops` under a non-C locale.
- PostgreSQL 16, [`pg_trgm`](https://www.postgresql.org/docs/16/pgtrgm.html): GIN/GiST support for non-left-anchored `LIKE` and the no-extractable-trigram caveat.
- PostgreSQL 16, [BRIN introduction](https://www.postgresql.org/docs/16/brin-intro.html): physical correlation, lossy block ranges, sizing, and summarization.
- PostgreSQL 16, [JSON indexing](https://www.postgresql.org/docs/16/datatype-json.html#JSON-INDEXING): generic GIN operator support and why targeted expression indexes can be smaller and faster.
- PostgreSQL 16, [`CREATE INDEX`](https://www.postgresql.org/docs/16/sql-createindex.html): immutability, `INCLUDE`, write-blocking versus concurrent builds, and concurrent-build failure cleanup.
- PostgreSQL 18 [release notes](https://www.postgresql.org/docs/18/release-18.html): btree skip scan was added in 18, so it must not be attributed to this PostgreSQL 16 server.

## Phase boundary

The blind reference is complete. Stop here: do not inspect M5 output or source, do not
compare, and do not assign a score in Phase 1.
