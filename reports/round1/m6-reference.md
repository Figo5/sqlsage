# M6 Round 1 blind reference — query rewriter

**Protocol state:** Phase 1 only. Written before any M6 implementation existed. No
`src/rewrite/` directory, no M6 output, and no M6 source were inspected or created. No
comparison, score, or verdict belongs in this file.

**Target:** PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1), database `sage`, schema `shop`,
session `TimeZone = Etc/UTC`, `work_mem = 32MB`, `random_page_cost = 1.1`,
`max_parallel_workers_per_gather = 2`, `jit = on`. Exactly eight baseline indexes: six
primary keys plus `idx_orders_customer_id` and `idx_order_items_order_id`.

**Coupling:** this file is the twin of `reports/round1/m5-reference.md`. Every
`requiresIndexes` value below is a stable id defined there. M5 and M6 are judged as a
measured pair; where M5 measured a rewrite+index combination, the number is reused and
cited rather than re-derived.

## What "ideal" means for M6

A `Rewrite` is not a prettier query. It must:

1. **Only exist when it is warranted.** Returning `[]` is the correct answer for a query
   that is already fast, or whose defect is not expressible as a rewrite. Precision is
   graded as hard as recall; q10 is the planted false positive.
2. **Classify `equivalence` correctly, and name the assumption.** `exact` only when
   provable or measured across the space of things that could break it. `conditional`
   must state the assumption *and* how to check it. `different-semantics` is the correct
   label when the original returns wrong answers — and the rationale must then say *the
   original is wrong*, not *the rewrite is faster*.
3. **State its index coupling.** `requiresIndexes` must carry real
   `IndexRecommendation.id` values, and the prose must distinguish "faster on its own"
   from "does nothing without index X". q01 is the proof case in both directions.
4. **Carry a measured `expectedSpeedup`**, honest about small or conditional wins, and
   silent (or explicitly "~0 ms") where there is none.
5. **Surface the non-code consequences.** q04 keyset pagination removes the ability to
   jump to page N. q07 cannot be rewritten at all until a human decides the intent.
   These are product decisions a rewriter must escalate, not silently make.

### Measurement protocol used here

Every number below carries the command that produced it. All rewrites were verified with
`node eval/verify.ts rewrite <id> "<SQL>" [--with-index "<DDL>"]`, which runs original and
candidate in separate rolled-back transactions, reports median-of-3 execution time
(cold run discarded), and fingerprints the **complete** result multiset — order-insensitive,
multiplicity-preserving — on both sides. A matching digest is therefore real evidence of
result equality on this data, not a sampled first page.

Two things it is **not** evidence of, and this reference never treats it as such:

- Equality on *other* data. A digest match proves the rewrite agrees on this seed. Where
  the two forms could diverge on different data (ties, NULLs, non-unique keys), that is
  called out separately and tested directly.
- A stable speedup ratio. Timings move with cache state across runs; the same rewrite
  measured 1.45x and 1.42x on two invocations. Plan shape, row counts, buffers, and
  order-of-magnitude effect are the authoritative evidence. Ratios are reported to two
  significant figures at most, and a ratio under ~1.15x is treated as noise.

---

## q01 — `date_trunc` on the filtered column → half-open range

### Warranted?

**Yes, priority 1.** This is the cleanest rewrite in the corpus: it is exact, it helps
on its own, and it is the precondition for the index that makes it a real win.

### The rewrite

```sql
SELECT c.country_code,
       count(*) AS order_count,
       sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE o.created_at >= TIMESTAMPTZ '2024-03-01'
  AND o.created_at <  TIMESTAMPTZ '2024-04-01'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC;
```

### Measured

```
node eval/verify.ts rewrite q01 "<above>"
  ORIGINAL 112.1 ms, 5 rows, digest e67a1388eae3c25c
  REWRITE   77.0 ms, 5 rows, digest e67a1388eae3c25c   → 1.45x, digest matches
  plan: still a parallel Seq Scan on orders (rows=24218 loops=2, filtered out 975782)

node eval/verify.ts rewrite q01 "<above>" --with-index \
  "CREATE INDEX idx_sqlsage_orders_status_created_cover ON shop.orders (status, created_at) INCLUDE (customer_id, total_cents)"
  ORIGINAL 106.5 ms, 5 rows, digest e67a1388eae3c25c
  REWRITE   29.8 ms, 5 rows, digest e67a1388eae3c25c   → 3.57x, digest matches
  plan: Index Only Scan on orders using idx_sqlsage_orders_status_created_cover
        (rows=24218 loops=2, 2.9 ms) feeding the Hash
```

The 3.57x here and M5's 3.94x/3.97x for the same pairing are the same measurement under
different cache states. Report it as "roughly 3.5–4x", not a fixed constant.

### Equivalence: `exact`

Assumption: none beyond "the two boundary literals are written in the same un-offset
`TIMESTAMPTZ 'YYYY-MM-01'` form as the original literal."

This is the one place in the corpus where "timezone-dependent" is commonly asserted and
is, for the *rewrite*, wrong. Both forms shift together, because the `TIMESTAMPTZ`
literals are resolved in the session zone exactly as `date_trunc('month', timestamptz)`
is. Measured:

```
docker exec sqlsage-pg psql -U postgres -d sage -c "SET TimeZone='Etc/UTC'; ..." 
  Etc/UTC:          date_trunc form 48437 rows, half-open form 48437 rows
  America/New_York: date_trunc form 48376 rows, half-open form 48376 rows
```

The *result set* is session-timezone dependent — 48,437 vs 48,376 complete orders for
"March 2024" — but that is a property of the original query, not something the rewrite
introduces. An M6 that says "the rewrite makes the query timezone-dependent" has it
backwards; the honest note is "both forms are session-timezone dependent, identically,
and if the business means UTC months the literals should be pinned
(`TIMESTAMPTZ '2024-03-01 00:00:00+00'`)."

Exhaustive check of the identity, using the PG 16 three-argument `date_trunc(text,
timestamptz, text)` (which is `IMMUTABLE`, unlike the two-argument timestamptz form which
is `STABLE` — confirmed via `pg_proc.provolatile` = `s` and `i` respectively):

```sql
-- 487 zone names x 20,000 sampled real orders; counts rows where the two
-- predicates disagree
SELECT count(*) AS zones_tested, count(*) FILTER (WHERE mismatches > 0) AS breaks ...
  → zones_tested 487, zones_where_identity_breaks 0
```

### Traps a builder will fall into here

- **`BETWEEN` with an inclusive upper bound.** `created_at BETWEEN '2024-03-01' AND
  '2024-03-31'` silently drops the whole last day: measured **46,869** rows against the
  correct **48,437**. That is a 1,568-row (3.2%) revenue understatement that looks right
  in a spot check. Never `BETWEEN` on a timestamp.
- **Proposing an expression index on `date_trunc('month', created_at)` instead of
  rewriting.** The two-argument timestamptz form is `STABLE`, so `CREATE INDEX` rejects
  it. See q09 for the same failure in its more famous spelling.
- **Claiming the rewrite alone is the fix.** It is 1.45x and still a sequential scan. The
  rewrite is what makes the index *usable*; the index is what makes it fast. Either one
  alone under-delivers, and M5 measured the index alone as 1.04x **slower**.

### Coupling

`requiresIndexes: ['idx-orders-status-created-cover']` — or
`'idx-orders-status-created-order-cover'` (the broader q04 definition) when the portfolio
deduplicates. The rewrite is beneficial without either (1.45x) but the headline number
requires one of them.

**`expectedSpeedup`:** "1.45x on its own; roughly 3.5–4x with
`idx-orders-status-created-cover`, converting the parallel Seq Scan to an Index Only Scan."

**`priority`: 1.**


---

## q02 — leading wildcard plus cross-column `OR`

### Warranted?

**Not the OR→UNION rewrite. That rewrite is a measured 6.9x regression here.** The one
rewrite that *is* warranted is small and is about determinism, not speed: add a
tie-breaker to the `ORDER BY`. Priority 2.

### Why OR→UNION fails on this query

The textbook transform needs both branches to be selective and indexable. Measured
selectivity:

```
docker exec sqlsage-pg psql -U postgres -d sage -c "SELECT count(*) FILTER (...) ..."
  email LIKE '%@example.com'                          200,000  (100% of the table)
  full_name LIKE 'Customer 1%'                        111,111
  both                                                111,111  (name branch ⊂ email branch)
  either (the actual OR)                              200,000  (100%)
  total customers                                     200,000
```

The `OR` matches every row in the table. There is no branch to prune, and the dedup step
is pure added cost:

```
node eval/verify.ts rewrite q02 "SELECT ... FROM ( ... UNION ... ) u ORDER BY signup_date DESC LIMIT 50"
  ORIGINAL  23.8 ms
  REWRITE  164.1 ms                                   → 6.90x SLOWER
  plan: Append(Seq Scan 200000, Seq Scan 111111) → HashAggregate over 311,111 rows → Sort
```

An M6 that emits a `UNION` split here and calls it an optimization is confidently wrong.

### Traps a builder will fall into here

1. **`UNION ALL` instead of `UNION`.** 111,111 customers satisfy both branches, so
   `UNION ALL` returns them twice. Measured overlap above: `both = 111,111`, exactly the
   whole name branch.
2. **`ORDER BY` on a column that is not in the `UNION`'s target list.** The obvious
   spelling is a hard parse error, not a slow query:
   ```
   SELECT customer_id, email, full_name FROM shop.customers WHERE email LIKE '%@example.com'
   UNION SELECT customer_id, email, full_name FROM shop.customers WHERE full_name LIKE 'Customer 1%'
   ORDER BY signup_date DESC LIMIT 50;
     ERROR:  column "signup_date" does not exist
   ```
   The fix is to carry `signup_date` into both branches and wrap in a subquery — which
   also changes what `UNION` deduplicates on, since two customers can no longer collapse
   unless `signup_date` also matches. Here `customer_id` is unique so it is harmless, but
   the reasoning must be stated, not assumed.
3. **"Leading wildcard ⇒ unindexable" stated without qualification.** It is unindexable
   *by btree*. `pg_trgm` GIN does serve infix `LIKE`. Measured in a rolled-back
   transaction with `CREATE INDEX ... USING gin (email gin_trgm_ops)`:
   ```
   WHERE email LIKE '%9876543%'      → Bitmap Index Scan on t_email_trgm   (index used)
   WHERE email LIKE '%@example.com'  → Seq Scan on customers (rows=200000) (index ignored)
   ```
   The correct statement is "a btree cannot serve it; a trigram index can, but not for
   *this* literal, because it matches every row." M5 measured the full trigram+pattern
   pair at 24.7 ms → 24.1 ms, both indexes unused.
4. **`text_pattern_ops`.** The `'Customer 1%'` branch is a genuine prefix match, but
   under this database's `en_US.utf8` collation a plain btree on `full_name` will not
   serve it; `text_pattern_ops` is required. This is a caveat on a rewrite that is not
   worth doing here, so M6 should not lead with it.

### The rewrite that *is* warranted

```sql
SELECT customer_id, email, full_name
FROM shop.customers
WHERE email LIKE '%@example.com'
   OR full_name LIKE 'Customer 1%'
ORDER BY signup_date DESC, customer_id DESC
LIMIT 50;
```

`signup_date` has exactly 100 customers per distinct value at the top of the range, so
`ORDER BY signup_date DESC LIMIT 50` selects 50 arbitrary rows out of 100 ties. **The
original query is not deterministic.** Measured, two consecutive executions of the
unmodified corpus query:

```
docker exec sqlsage-pg psql ... md5(string_agg(customer_id::text, ','))
  run 1  cfff1d84d8e0f26c78636d8d6cc57d7a
  run 2  e0a44c2037717d36daa60df7e2eac5bf     ← different page, same query
with ", customer_id DESC" added:
  run 1  f391e8ddee7bcee1c10eb4260b8f9884
  run 2  f391e8ddee7bcee1c10eb4260b8f9884     ← stable
```

The harness saw the same thing from three separate angles: the stored ground-truth digest
is `920fcf567f096a3a`, and three later `verify.ts` runs of the *unmodified* query produced
`b6294a2746e939c0`, `fd484e4fe6d72421`, and `cc07f42ecbbbe633`.

**Consequence for every other rewrite of q02: the digest is not a valid equivalence
oracle here.** A builder who reports "digest matches" on q02 got lucky, and one who
reports "digest DIFFERS, rewrite rejected" has misread the evidence. Equivalence on q02
must be argued on the predicate, and verified with a tie-broken order.

### Equivalence: `different-semantics` (narrowing, and deliberately so)

The tie-breaker rewrite returns a *specific* 50 rows where the original returned an
arbitrary 50. It is not `exact` — it constrains a result the original left undefined.
Calling it `exact` is the wrong label even though no user would call the change a
regression. State it as: *the original had no defined answer; this one does.*

### Coupling

`requiresIndexes: ['idx-customers-signup-date-desc']`, optional but transformative. With
that index the original shape becomes a 50-entry ordered index scan:

```
node eval/verify.ts rewrite q02 "<original>" --with-index \
  "CREATE INDEX idx_sqlsage_customers_signup_date_desc ON shop.customers (signup_date DESC)"
  ORIGINAL 26.0 ms → 0.0 ms (sub-0.05 ms)
  plan: Limit → Index Scan on customers using idx_sqlsage_customers_signup_date_desc (rows=50)
```

Note honestly: this is an **order-driven** win, not a filter win, and it depends on the
`OR` matching a large fraction of the table so that 50 qualifying rows appear immediately.
If the search terms were selective, the same index would walk many entries before
finding 50, and the win would evaporate or invert. The tie-breaker version needs the
index spelled `(signup_date DESC, customer_id DESC)` to avoid a residual sort.

**`expectedSpeedup`:** none from the rewrite itself. "Determinism, not speed."

**`priority`: 2.** An M6 that returns `[]` for q02 has missed the determinism defect but
has *not* committed the worse error of proposing the UNION.

---

## q03 — two correlated scalar subqueries → one `LATERAL`

### Warranted?

**Yes, but priority 3 and with the speedup stated honestly as ~0 on its own.** The SQL
looks alarming and is already fast: 31.5 ms, because only 2,000 gold customers are
selected and `idx_orders_customer_id` turns each subquery into a ~10-row index probe.
The rewrite's real merit is that it halves the number of probes (4,000 → 2,000) and
states the intent once instead of twice. On the current indexes that is worth nothing
measurable; with the M5 indexes it becomes worth something.

### The rewrite

```sql
SELECT c.customer_id, c.email,
       a.order_count,
       a.last_order_at
FROM shop.customers c
LEFT JOIN LATERAL (
  SELECT count(*) AS order_count, max(o.created_at) AS last_order_at
  FROM shop.orders o WHERE o.customer_id = c.customer_id
) a ON true
WHERE c.loyalty_tier = 'gold'
ORDER BY a.order_count DESC;
```

### Measured

```
node eval/verify.ts rewrite q03 "<above>"
  ORIGINAL 31.3 ms, 2000 rows, digest 7b9e8e20d2190087
  REWRITE  29.3 ms, 2000 rows, digest 7b9e8e20d2190087   → 1.07x (noise), digest matches
  plan: Nested Loop → Seq Scan customers (2000, filtered out 198000)
        → Aggregate (loops=2000) → Index Scan using idx_orders_customer_id (rows=10)
        i.e. 2,000 probes instead of the original's 4,000

node eval/verify.ts rewrite q03 "<above>" --with-index \
  "CREATE INDEX idx_sqlsage_customers_gold_customer_cover ON shop.customers (customer_id) INCLUDE (email) WHERE loyalty_tier = 'gold'" \
  "CREATE INDEX idx_sqlsage_orders_customer_created_desc_cover ON shop.orders (customer_id, created_at DESC) INCLUDE (order_id, total_cents)"
  ORIGINAL 41.8 ms → REWRITE 5.3 ms, digest matches            → 7.93x
  plan: Index Only Scan on customers using the partial gold index (rows=2000, 0.1 ms)
        → Aggregate (loops=2000) → Index Only Scan on orders (rows=10)
```

For calibration: M5 measured the *original* SQL with the same index pair at 29.7 ms →
7.5 ms. So of the total improvement, the indexes do nearly all the work and the rewrite
contributes roughly a further 2 ms. The correct `expectedSpeedup` prose is *"negligible
on its own; the index pair is what matters, and the rewrite adds a small amount on top of
it by halving the probe count."* Any claim that collapsing the subqueries is itself a
large win is unsupported here.

### Equivalence: `exact`

Assumption, and it is real: **the `LATERAL` body must be an aggregate with no `GROUP BY`.**
Such a subquery returns exactly one row even when no orders match — `count(*)` = 0,
`max()` = NULL — which is precisely the scalar-subquery semantics being replaced. Because
of that, `LEFT JOIN LATERAL ... ON true` and `CROSS JOIN LATERAL` are interchangeable
here, and no `COALESCE` is needed.

### Traps a builder will fall into here

1. **The pre-grouped derived table, which is a 13x regression.** The "obvious"
   de-correlation is to `GROUP BY customer_id` once and join. Measured:
   ```
   node eval/verify.ts rewrite q03 "... LEFT JOIN (SELECT customer_id, count(*), max(created_at)
                                     FROM shop.orders GROUP BY customer_id) a ON ..."
     ORIGINAL  34.8 ms
     REWRITE  452.8 ms                                  → 12.99x SLOWER
     plan: Aggregate (rows=200000) ← Seq Scan on orders (rows=2000000)
   ```
   It aggregates all 2,000,000 orders into 200,000 groups and then discards 198,000 of
   them, because the `loyalty_tier = 'gold'` restriction cannot be pushed into the
   grouped subquery. The correlation that looks like the bug is what keeps the query
   fast. This is the single most likely wrong answer on q03.
2. **Dropping the `COALESCE` in the grouped form and getting away with it on this data.**
   The grouped `LEFT JOIN` yields `NULL`, not `0`, for a customer with no orders — but
   **every one of the 200,000 customers in this seed has at least one order**
   (`count(*) FILTER (WHERE NOT EXISTS (...)) = 0`), so the digest matches anyway and the
   defect is invisible. Demonstrated directly against a synthetic id:
   ```
   customer_id | scalar_subquery_count | lateral_count | grouped_join_count
             1 |                    10 |            10 |                 10
          -999 |                     0 |             0 |             (NULL)
   ```
   A rewrite verified only by digest on this corpus will ship this bug. `LATERAL` does
   not have the problem; the grouped join needs `COALESCE(a.order_count, 0)`.
3. **`JOIN` instead of `LEFT JOIN` on the grouped form.** Same silent-drop failure, also
   invisible on this seed for the same reason.
4. **Treating "correlated subquery" as automatically a defect.** 4,000 ten-row index
   probes over a 2,000-row driver is a good plan. The catalog fact that makes it good —
   `loyalty_tier = 'gold'` is 1% of 200,000 rows — is the thing to cite.

### Coupling

`requiresIndexes: ['idx-customers-gold-customer-cover', 'idx-orders-customer-created-desc-cover']`,
both optional. The rewrite is correct and marginally better without them.

**`expectedSpeedup`:** "≈1.0x alone (31.3 → 29.3 ms, within noise). About 8x
(41.8 → 5.3 ms) paired with the two M5 indexes, of which the indexes supply most of the
gain. Absolute saving is tens of milliseconds — worth doing only if this query is hot."

**`priority`: 3.**
