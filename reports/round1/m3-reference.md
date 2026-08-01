# M3 blind reference — predicted execution analysis

**Round:** 1  
**Module:** M3 (`predictExecution(ir, catalog): ExecutionAnalysis`)  
**Protocol state:** Phase 1 only. This reference was written before an M3 implementation existed. I did not read `src/plan/`, any M3 output, or any M3 builder reasoning.

## What the reference is judging

An expert offline predictor should use only facts represented by `QueryIR` and `Catalog` to produce the `ExecutionAnalysis` contract:

- likely access path per relation;
- likely join or correlated-subplan strategy and output magnitude;
- runtime drivers ranked by impact rather than by position in the plan tree;
- current spill risk at the catalog's `work_mem`, without inventing a spill merely because a sort or hash exists;
- row-estimation hazards and their likely direction; and
- scaling behavior as table size, match count, page depth, or per-key fan-out grows.

The final catalog describes PostgreSQL 16.14, `work_mem = 32MB`, `max_parallel_workers_per_gather = 2`, and `random_page_cost = 1.1`. Baseline indexes are only the primary keys, `idx_orders_customer_id`, and `idx_order_items_order_id`.

### Calibration and evidence rules

The offline analysis and the live-plan check are deliberately separate below. Values under **Offline reference** are derivable from the IR/catalog. Values under **PG16 sanity check** come from the captured `EXPLAIN (ANALYZE, BUFFERS)` and must not be presented as if the offline analyzer knew them.

Several facts cannot be recovered from the current catalog contract: histogram bounds, extended/multivariate statistics, expression statistics, visibility-map coverage, current cache warmth, CPU/I/O speed, and most planner cost parameters. Therefore an expert predictor should use ranges, omit optional `estimatedRows`/`estimatedShare` fields when support is weak, and request live verification. Exact elapsed milliseconds, buffer counts, worker count, hash batches, and sort spill are live facts—not legitimate offline promises.

The plan checks follow PostgreSQL's own guidance: upper-node time includes child time, cost units are not milliseconds, and `actual time`/`rows` are per-loop averages, so repeated-node work must be evaluated as `time × loops`. Buffer traffic and rows removed by filters are used alongside elapsed time. No captured plan spilled: there are zero nonzero temp-block counters, disk sorts, or multi-batch hashes across the twelve plans.

---

## q01 — nonsargable monthly date filter

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `orders o` | `seq-scan` (parallel is plausible) | unknown; at most ~1.70M after the status filter | The only usable indexes are the PK and `customer_id`; neither serves `status` or `created_at`. `date_trunc('month', created_at)` is not an index condition on a plain `created_at` btree anyway. `status='complete'` retains about 85% before the month filter. The catalog has no histogram/statistics for the `date_trunc` expression, so even a coarse month fraction would be invented rather than derived. |
| `customers c` | `index-scan` using `customers_pkey` if the filtered order stream is modest; otherwise a hash-build seq scan remains a credible alternative | one row per surviving order | The join targets a unique PK. With a modest filtered stream and low `random_page_cost`, repeated PK probes are plausible, but the exact nested-loop/hash crossover needs the missing month selectivity and the planner. |

**Join strategies**

- `o.customer_id = c.customer_id`: the join is many-to-one (`Inner Unique`) and should not multiply rows. Predict a parameterized `nested-loop` only conditionally on a modest month result; a hash join over all 200k customers is equally credible if that unknown result is large. This is a case where the ideal offline output should expose the crossover instead of asserting one algorithm with false confidence.

**Dominant costs, ranked**

1. Reading and evaluating both predicates over all 2M `orders` rows. The month predicate is CPU work on every row, and the scan remains O(table size) even though only one month is returned.
2. One customer PK probe per surviving order if nested loop wins. It is a small lookup individually but can dominate buffer touches in aggregate.
3. Grouping the surviving rows into only five country groups. A partial aggregate and final merge are plausible; this should be materially smaller than the full scan and join unless the month predicate is unexpectedly broad.
4. Sorting five aggregate rows by revenue. This is negligible and should never be described as the bottleneck.

**Memory/spill**

- `memoryRisks: []` at current magnitude. The country grouping and five-row final sort are tiny. A live plan is still required to confirm the exact aggregate strategy.

**Estimation risks**

- **Under, high confidence:** the planner/analyzer lacks statistics for `date_trunc('month', created_at)`, so the month predicate is likely to use a generic expression selectivity.
- **Unknown:** correlation between `status='complete'` and month. Single-column status MCV data cannot support multiplying the predicates as if independent with high confidence.

**Scalability**

- Summary: linear in all orders plus output-sensitive PK probes: `O(N_orders + M_month_complete × log N_customers)`. More workers can reduce elapsed scan time but not total work. Growth in historical orders hurts even if the requested month stays fixed.

### PG16 sanity check

- Actual plan: parallel seq scan of all 2M orders, then nested-loop PK lookups into customers, partial/final group aggregate, and a five-row quicksort.
- The order scan emitted 16,146 rows per process across three processes (~48.4k total) and removed 650,521 per process. Its estimate was 3,541 per process, about **4.6× low**, validating the expression-statistics warning.
- The customer index scan ran **48,437 loops** and accounted for **193,750 of 214,394 shared hits**. Although each probe averaged only ~0.001 ms, the probe count and buffers make it a co-dominant cost with the full orders scan.
- Sorts stayed in memory (about 1.0–1.4MB per worker for grouping input; 25kB final). Median execution was **111.7 ms**. No spill claim is warranted.

**Offline/live boundary:** access-path direction, join uniqueness, scan scale, and cost ordering are predictable. The ~48.4k match count, nested-loop choice, parallelism, 4.6× estimate miss, 214k buffer hits, and milliseconds require live `EXPLAIN ANALYZE`.

---

## q02 — leading-wildcard OR search

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `customers` | `seq-scan` (parallel is plausible) | omit/unknown; anywhere from a small fraction to nearly 200k | There is no index on `email`, `full_name`, or `signup_date`. The leading-wildcard email branch cannot use a plain btree; the prefix branch has no available index; and the OR must evaluate both branches against the heap. Unique-value counts do not reveal LIKE-pattern selectivity or overlap. |

**Join strategies**

- None.

**Dominant costs, ranked**

1. Scanning all 200k customers and evaluating two LIKE predicates. This remains necessary regardless of `LIMIT` because there is no access path that supplies both filtering and order.
2. Maintaining a top-N heap for the best 50 `signup_date` values among all matches, followed by a small gather/merge if parallel. This processes every matching row but uses bounded memory; it is not a full in-memory sort of all matches.
3. Returning 50 rows is negligible.

**Memory/spill**

- `memoryRisks: []`. `LIMIT 50` allows top-N heapsort with memory proportional to 50 rows, not the full match set.

**Estimation risks**

- **Unknown/high:** no suffix/prefix distribution is represented in `ColumnStats`, and the overlap between `email LIKE ...` and `full_name LIKE ...` is unavailable. Generic LIKE and OR selectivity can be far from reality.
- Parallelism is a planner threshold decision; 24.5MB of heap is small enough that a serial scan is also plausible on a different machine/cache state.

**Scalability**

- Summary: current-fast but linearly scaling: `O(N_customers × pattern_cost + M_matches log 50)`, effectively O(N). The 50-row limit controls memory/output, not rows inspected. Doubling customers roughly doubles predicate work.

### PG16 sanity check

- Actual plan: parallel seq scan (leader + one worker), top-N heapsort per process, then `Gather Merge`/`Limit`.
- All **200k customers matched** (~100k per process). That fact is not inferable from the exported text statistics.
- The scan reached ~12 ms per process and the inclusive sort node ~20.4 ms; total was **22.4 ms median**. The plan touched only 2,476 shared buffers, explaining why it is fast today despite scanning everything.
- Top-N heaps used only 34–35kB and did not spill. The correct calibration is “fast at 200k, structurally linear,” not “slow because it sorts 200k rows.”

**Offline/live boundary:** full-scan necessity, bounded top-N behavior, and linear scaling are offline conclusions. Actual all-row selectivity, one worker, cache hits, and 22 ms are live facts.

---

## q03 — two correlated scalar aggregates

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation/role | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `customers c` | `seq-scan` | ~1,953 gold customers | `gold` is an MCV at 0.9767% of 200k, but there is no loyalty-tier index, so the engine must scan all customers. |
| `orders o` in `count(*)` | `index-only-scan` using `idx_orders_customer_id` (visibility dependent) | ~10 index tuples per outer customer, one scalar result | The key predicate is indexed and the count needs no heap column. Whether it is truly index-only at runtime depends on the visibility map, which the catalog does not expose. |
| `orders o2` in `max(created_at)` | `index-scan` using `idx_orders_customer_id` | ~10 heap tuples per outer customer, one scalar result | The index locates a customer's orders, but it does not contain `created_at`, so heap access is required. |

**Join/subplan strategies**

- Two correlated scalar subplans, execution-equivalent to parameterized `nested-loop` work: each subplan executes once for each of ~1,953 outer gold customers. Expect about 3,906 aggregate invocations and roughly 39k order-index tuples visited in total.

**Dominant costs, ranked**

1. The `max(created_at)` subplan: ~2k repeated heap-fetching index scans over ~10 orders each.
2. The outer full scan of 200k customers to find ~1% gold rows.
3. The `count(*)` subplan: another ~2k scans of the same order keys, cheaper if index-only but still duplicated work.
4. Sorting ~2k result rows by the computed count; safely in memory and minor.

**Memory/spill**

- `memoryRisks: []`. Each scalar aggregate holds constant state and the final ~2k-row sort is small.

**Estimation risks**

- Low at current catalog quality: gold selectivity has an exact MCV and average orders/customer is about 2M / 201.8k ≈ 10.
- **Unknown:** cache residency and visibility-map coverage decide whether repeated probes are cheap hits and whether the count path avoids heap fetches.

**Scalability**

- Summary: current-fast but repeated-work scaling: `O(N_customers + G × 2 × (log N_orders + k_orders_per_customer))`. It is acceptable at ~2k gold customers and ~10 orders each, but grows with both gold population and order history; the same order set is traversed twice.

### PG16 sanity check

- Actual outer scan found 2,000 gold customers after removing 198,000; the estimate was 1,953.
- Both subplans ran **2,000 loops**. Each saw exactly 10 orders on average. The count used an index-only scan with **0 heap fetches** and 6,001 hits; max used a heap index scan and 26,000 hits.
- The max subplan is the I/O leader; the two subplans plus outer heap accounted for all 34,440 hits. Final quicksort used 189kB.
- Median was only **31.5 ms**, so calling the current query catastrophic would be miscalibrated. The expert point is duplicated parameterized work and its growth curve.

**Offline/live boundary:** the ~1,953 driver count, ~10 rows/probe, repeated-subplan shape, and relative max-vs-count cost follow from IR/catalog/index coverage. Zero heap fetches, 34k cache hits, and 31 ms require runtime evidence.

---

## q04 — deep OFFSET pagination

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `orders o` | `seq-scan` (parallel likely) | ~1.70M complete orders | `complete` is 84.99% of 2M and no status/order index exists. Reading most of the heap sequentially is cheaper than any unrelated index. |
| `customers c` | `seq-scan` to build a hash table | 200k | Almost every surviving order needs a customer row; probing the PK ~1.7M times is less attractive than hashing the 200k-row dimension. |

**Join strategies**

- `o.customer_id = c.customer_id`: predict `hash-join`, probably parallel, output ~1.70M rows. The customer side is unique, so row count should be preserved.

**Dominant costs, ranked**

1. Scanning/filtering 2M orders and joining ~1.7M to customers.
2. Top-N sorting with **N = offset + limit = 100,020**, not N=20. Every qualifying joined row must be considered and each worker may retain a large candidate heap.
3. Merging at least 100,020 ordered candidates and discarding the first 100,000 at `Limit`.
4. Building the 200k-customer hash; meaningful but smaller than the order stream and top-N processing.

**Memory/spill**

- Current prediction: no guaranteed spill, but the top-N heap is the boundary risk. With ~46-byte rows, 100,020 candidates plus tuple overhead can approach 32MB per process. The 200k-customer hash should be tens of MB. Exact executor overhead, parallel allocation, and spill need live verification.

**Estimation risks**

- Status selectivity is reliable from the MCV. Join cardinality is reliable because the FK targets a unique customer PK.
- Memory use is less certain than row count; executor tuple overhead is not represented by average column widths alone.

**Scalability**

- Summary: `O(N_orders + N_customers + M_complete log(offset + limit))`, with memory O(offset + limit). Cost grows with total order volume and page depth; OFFSET also imposes a hard lower bound of producing/discarding 100k rows. Deeper pages can cross into disk sort.

### PG16 sanity check

- Actual plan: parallel seq scans, parallel hash join, top-N heapsort per process, `Gather Merge`, then `Limit`.
- It produced ~1.70M joined rows (566,667 per process). The inclusive hash join reached ~235.7 ms; inclusive top-N sort ~370.4 ms, making sorting the largest incremental stage after the scan/join.
- Each top-N heap used **20,210kB**, below 32MB, and the customer hash used 14,624kB in one batch. No spill occurred.
- The gather emitted 100,020 rows so the limit could discard 100,000. Total was **392.5 ms median**, with 23,217 shared hits and ~13 ms JIT in the displayed run.

**Offline/live boundary:** the 1.7M magnitude, hash-join direction, top-N bound of 100,020, and page-depth scaling are offline. The 20.2MB heaps, no-spill outcome, worker count, and 393 ms are live.

---

## q05 — `NOT IN` over a nullable subquery column

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `events e` subquery | `seq-scan` (parallel likely) | ~93k checkout rows before dedup/hash | `checkout` is 1.8667% of 5M events and there is no event-type index. |
| `customers c` | `seq-scan` | output is **not safely estimable as a fraction** | The hashed membership test is applied to every customer. If the checkout subquery contains even one NULL, SQL three-valued logic rejects every outer row; otherwise output depends on membership coverage. |

**Join/subplan strategies**

- Do **not** label this a hash anti-join. On PostgreSQL 16 the nullable `NOT IN` remains a hashed SubPlan (if estimated to fit), not an anti-join. `joinStrategies` may be empty or use `algorithm: unknown` with the explicit reason that a hashed membership subplan is outside the contract's join-algorithm enum.
- Correctness leads the analysis: `events.customer_id` is nullable (`nullFrac = 0.145`). The catalog lacks conditional NULL statistics for checkout events, so offline output must be phrased conditionally: “a NULL is possible and would make the result empty,” not as a proven checkout-specific count.

**Dominant costs, ranked**

1. Full scan of 5M events to select checkout customer IDs.
2. Building/probing the hashed SubPlan and scanning all 200k customers.
3. Returning rows is either zero (if a NULL is present) or output-sensitive; it is not the primary cost.

**Memory/spill**

- ~93k bigint values should ordinarily fit at 32MB, so do not predict a current spill. Hash memory is still a scale risk: a much larger subquery can force a different/materialized strategy because hashed SubPlans are bounded by planner memory assumptions.

**Estimation risks**

- **Catastrophic/unknown direction for outer rows:** single-column `nullFrac` does not describe `customer_id IS NULL` conditional on `event_type='checkout'`. The result can jump from many rows to exactly zero based on one qualifying NULL.
- Checkout scan cardinality should be close because `event_type` has an MCV; distinct customer coverage is not represented.

**Scalability**

- Summary: `O(N_events + N_customers)` time and O(distinct checkout customer IDs) memory while hashing is chosen. It cannot short-circuit the event scan as an index-backed anti-join could.

### PG16 sanity check

- Actual plan is exactly a parallel events seq scan feeding `hashed SubPlan 1`, followed by a customer seq scan—not an anti-join.
- The subquery returned **100,000** checkout rows; the event scan removed ~4.9M rows and incurred 80,341 event buffers (76,730 reads). It reached ~104 ms and dominates the **148.6 ms median**.
- The outer planner estimated 100,000 rows but returned **0**, removing all 200,000 customers. The live dataset contains NULL checkout customer IDs, validating the correctness warning and showing why a generic 50% anti-membership estimate is unusable here.
- No temp I/O or spill was reported. Performance is secondary to the empty-result bug.

**Offline/live boundary:** nullable-column risk, lack of anti-join conversion, event seq scan, and approximate 93k checkout rows are offline. The presence/count of NULLs in the checkout subset, exact zero output, 76k disk reads, and runtime are live facts.

---

## q06 — order-item fan-out before customer aggregation

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `orders o` | `seq-scan` (parallel likely) | ~1.70M complete orders | 85% status selectivity and no status index make a seq scan the natural path. |
| `order_items oi` | `seq-scan` (parallel likely) | 6.0M | Most items belong to complete orders; probing `idx_order_items_order_id` ~1.7M times is less attractive than a bulk scan/hash join. |
| `customers c` | `seq-scan` as a hash build | 200k | The 200k-row unique dimension is reused for millions of order-item rows. |

**Join strategies**

- `oi.order_id = o.order_id`: predict `hash-join`, output about **5.1M rows**: 1.70M complete orders × roughly 3 items/order. The FK-to-PK join is many-to-one from items to orders, but joining orders outward to items multiplies every order.
- Result to `customers` on customer PK: predict `hash-join`, still about 5.1M rows because the customer side is unique.

**Dominant costs, ranked**

1. Processing the 5.1M-row fan-out through two hash joins. This is also a correctness defect: `sum(o.total_cents)` is repeated once per item, so runtime is not the main story.
2. Partial/final hash aggregation of 5.1M rows into at most 200k customer groups. `count(*)` counts item rows; revenue scales with item multiplicity.
3. Scanning the 6M-row `order_items` heap, likely the largest base-table I/O source.
4. Scanning/hashing 1.7M complete orders and 200k customers.
5. Top-N sorting ~200k groups to 100; bounded-memory and smaller than the join/aggregate pipeline.

PostgreSQL may use only `c.customer_id` as the physical group key because the customer PK functionally determines `email`; retaining `email` in the SQL `GROUP BY` does not require a wider executor group key.

**Memory/spill**

- Do not claim a guaranteed current disk spill: hash joins/aggregates may use the hash memory multiplier and parallel shared memory. Predict **high concurrent memory pressure** from an order-side hash plus partial aggregates in leader/workers and a final aggregate. Whether batches exceed one is a live fact.

**Estimation risks**

- **Unknown/moderate:** catalog FKs and table counts imply ~3 items/order, but it has no multivariate statistic showing whether item count correlates with order status. Independence yields ~5.1M; status-specific fan-out could differ.
- Customer group count is at most 200k and likely below it, but the number with at least one complete order is not directly stored.

**Scalability**

- Summary: linear base work `O(N_items + N_orders + N_customers)` with very large fan-out/aggregate constants and memory O(groups + hash inputs). If hashes spill, extra partition I/O appears. The result error grows in direct proportion to average items/order; the compute cost grows with the same fan-out.

### PG16 sanity check

- Actual plan used parallel seq scans, a parallel hash join of items to complete orders, a second parallel hash join to customers, partial/final hash aggregates, and a 100-row top-N sort.
- The first join emitted **1.70M rows per process across three processes = 5.10M**, exactly three item rows per complete order in this corpus. The second join preserved that magnitude. This is why revenue is over-reported by exactly 3×.
- Ranked wall-time evidence: the two-join pipeline grew from ~200 ms startup to ~1,679 ms inclusive; partial aggregation then reached ~2,133 ms per process and finalization ~2,404 ms. The top-N sort added only tens of milliseconds. Median total was **2,401.6 ms**.
- Buffer evidence: 67,187 total shared buffers, including **43,734 reads** from `order_items`; order and customer hashes were cache hits. The order hash used **109,600kB**; each partial aggregate and the final aggregate reported **36,881kB**; customer hash used 14,656kB. All hashes were one batch and no temp I/O occurred, but aggregate memory exists per participating process, so concurrency pressure is real.
- Estimate calibration was acceptable for plan choice: 2.125M vs 1.70M rows per process at the large joins (~1.25× high), and 200k vs 170k final groups. That does not reduce the semantic severity of fan-out.

**Offline/live boundary:** access paths, hash direction, ~5.1M independence estimate, fan-out correctness effect, and aggregate/memory risk are offline. Exact threefold correlation, 170k groups, hash peak memory/batches, read blocks, and 2.4 s are live.

---

## q07 — LEFT JOIN demoted by a null-rejecting WHERE predicate

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `customers c` | `seq-scan` (parallel plausible) | omit/unknown from exported stats | There is no `signup_date` index. `nDistinct` alone does not provide the date range's fraction because histogram bounds are absent from `Catalog`. |
| `orders o` | `index-scan` using `idx_orders_customer_id` | ~8–9 complete orders per qualifying customer | The selective customer subset can drive parameterized lookups. Average orders/customer is ~10 and `complete` is ~85%; status remains a heap filter because it is not part of the index. |

**Join strategies**

- Predict a `nested-loop` from qualifying customers into `idx_orders_customer_id` at medium/high confidence.
- The `WHERE o.status='complete'` predicate is null-rejecting. It removes every NULL-extended row, so the logical left join is equivalent to an inner join and PostgreSQL 16 should be free to demote/reorder it. The execution analysis must say this explicitly: no performance penalty from an outer-join barrier is expected, but customers without complete orders are not preserved. If preservation was intended, this is a correctness defect.

**Dominant costs, ranked**

1. Repeated order index/heap probes—roughly one probe per qualifying customer and ~10 order rows examined per probe.
2. Full customer scan to find the signup-date subset.
3. Producing a large result set (potentially many order rows per customer) and gathering it to the leader/client.

**Memory/spill**

- `memoryRisks: []`. There is no sort or large hash in the likely nested-loop plan.

**Estimation risks**

- **Unknown:** qualifying signup-date rows without histogram min/max/bounds.
- **Moderate:** correlation between recent signups and complete-order count is not represented by single-column stats. The final join estimate can be wrong even if the average orders/customer and status MCV are individually accurate.

**Scalability**

- Summary: `O(N_customers + Q_recent × (log N_orders + k_orders_per_customer))`, plus O(output rows). It is linear in customer history and recent-customer population; there is no outer-join-specific cost once demoted.

### PG16 sanity check

- The actual plan contains a plain `Nested Loop`, not `Nested Loop Left Join`, confirming planner demotion.
- Parallel customer scan found **17,400** qualifying customers total. The order index scan ran **17,400 loops**, emitted 9 complete orders per loop, and removed 1 non-complete row per loop, producing exactly **149,000 rows**.
- The order probes dominate: **226,201 of 228,640 shared hits** and ~61 ms incremental time inside the nested-loop region. The customer scan used 2,439 hits and ~5.5 ms; output/gather then contributes additional elapsed time.
- Median total was **88.2 ms**, with no sort, hash, or spill. The plan is efficient for the SQL as written; the danger is intent/correctness, not failure to optimize the LEFT JOIN.

**Offline/live boundary:** null rejection/demotion, nested-loop direction, and ~8.5 complete orders per customer are offline. The date selectivity, 17.4k loops, 149k output, and 226k buffer hits are live.

---

## q08 — DISTINCT cleans up join fan-out

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation/role | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `products p` | `seq-scan` | ~250 products | `category_id` has ~200 distinct values across 50k products and no supporting index. The small heap is cheap to scan/hash. In a parallel non-shared hash plan this small scan may be repeated per process. |
| `order_items oi` | `seq-scan` (parallel likely) | 6M scanned; ~30k match category products under uniformity | There is no `product_id` index. Joining the 250-product hash against the entire 6M-item heap is the only useful baseline bulk path. |
| `orders o` | `index-scan` using `orders_pkey` | one lookup per matching item; surviving fraction unknown | After category filtering leaves tens of thousands of items, PK probes are plausible. `created_at` is a heap filter. The exported catalog lacks date histogram bounds. |
| `customers c` | `index-scan` using `customers_pkey` | one lookup per surviving order-item row | The customer join is unique and the post-date stream is modest. |

**Join strategies**

- `oi.product_id = p.product_id`: `hash-join`, output roughly 6M × 250/50k ≈ **30k** item rows if category membership is uniform.
- Category items to orders: `nested-loop` PK lookup, at medium confidence; a hash join becomes plausible if category selectivity is much broader.
- Surviving orders to customers: `nested-loop` PK lookup. Both PK joins are many-to-one and preserve the item-row magnitude.
- `DISTINCT` then collapses item/order fan-out to customer grain; final distinct rows cannot be inferred from independent table statistics.

**Dominant costs, ranked**

1. Full parallel scan of 6M order items and hash probe against category products.
2. Tens of thousands of random/cache-resident order PK probes and the date filter.
3. Customer PK probes for every surviving item row, including duplicates for the same customer.
4. Sort/unique or hash aggregate across the wide customer tuple to remove duplicates. This is real wasted work but need not be the current top wall-time node.
5. Product scan/hash, small even if duplicated across workers.

**Memory/spill**

- Current category estimate suggests no spill: a ~250-row product hash and tens-of-thousands-row DISTINCT input should fit in 32MB. A broader category/time range makes DISTINCT's sort/hash memory grow with item matches, not final customers.

**Estimation risks**

- **High, usually over for final distinct groups:** the catalog cannot estimate how many matched items/orders collapse to the same customer across a four-table chain. Single-column distinct counts do not encode cross-table duplication.
- Date selectivity and correlation between product category, order date, and customer are unavailable.

**Scalability**

- Summary: `O(N_order_items + M_category_items × (log N_orders + log N_customers) + M_survivors log M_survivors)` for a sort/unique plan. Work scales with all matching items even though output is customer grain; a broader predicate can cause sort spill.

### PG16 sanity check

- Actual plan: each of three processes builds a tiny hash from a full products scan (250 matches, 49,750 removed), probes it during a parallel seq scan of order_items, then performs nested-loop PK lookups into orders and customers. Per-worker sort/unique feeds a global `Gather Merge`/`Unique`.
- The item/product join emitted **30,000** rows total. Orders PK ran 30,000 loops and left 19,935 rows after date filtering; customers PK ran 19,935 loops. Those rows collapsed to **3,000** final customers.
- Ranked evidence: order-items scan/hash join reached ~237 ms and read 43,158 blocks; order probes consumed 120,002 shared hits; customer probes another 79,742. Per-worker distinct sorts used only ~603–614kB. Median total was **296.1 ms**.
- Estimates were good through the item join (~1.25× high) but the top `Unique` estimated 16,530 final rows versus 3,000 actual (**5.5× high**), exactly the cross-table duplicate-risk an offline predictor should flag.

**Offline/live boundary:** base paths, ~250 products, ~30k item matches, nested PK probes, fan-out cost, and distinct-risk direction are offline. The date survival fraction, 3k final customers, 5.5× miss, read/cache balance, and 296 ms are live.

---

## q09 — date cast on every order row

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `orders o` | `seq-scan` (parallel likely) | matched rows unknown; final groups bounded at 30 | No baseline index exists on `created_at`, so the baseline must seq-scan even without the cast. In addition, `created_at::date` would prevent a plain future btree on `created_at` from becoming an index condition. The analyzer must not falsely attribute the current scan solely to the cast when the index is absent. |

**Join strategies**

- None.

**Dominant costs, ranked**

1. Scanning 2M orders and evaluating the timezone-dependent `timestamptz::date` expression plus range checks on every row.
2. Sorting matching date values for grouped aggregation if PostgreSQL chooses GroupAggregate; a hash aggregate is also plausible offline. The query semantics bound the final groups to at most 30 dates even though the planner may not infer that expression bound.
3. Merging/finalizing at most 30 groups and ordering those groups; negligible.

**Memory/spill**

- No current spill should be predicted for a one-month match set at 32MB without a defensible match count. If a much wider date interval is used, the pre-aggregate sort can grow and should be verified.

**Estimation risks**

- **Under for filtered rows:** there are no statistics on `created_at::date`; generic range selectivity can miss the actual month fraction.
- **Over for groups:** the planner may treat the expression as having many distinct values even though the literal date interval proves there can be no more than 30 output keys.
- Time zone is absent as a fixed query assumption; it affects which timestamps land on each date, though not the 30-key upper bound.

**Scalability**

- Summary: `O(N_orders + M_month log M_month)` for the observed sort/group shape, dominated by O(N_orders). Historical table growth increases work even for the same June window.

### PG16 sanity check

- Actual plan: parallel seq scan, per-process sort, partial/final GroupAggregate, `Gather Merge`.
- The scan emitted **55,149 rows total** (~18,383 per process) and removed ~1.945M. It reached ~78 ms in the displayed run and touched 20,630 shared buffers; sorting/partial grouping added only a few milliseconds.
- The scan estimate was 4,167 vs 18,383 rows per process (**~4.4× low**). The top aggregate estimated 10,000 groups but produced 30 (**~333× high**).
- Worker sorts stayed below 769kB, no spill. Median was **81.4 ms** (the displayed analyzed run completed in ~90 ms).

**Offline/live boundary:** seq-scan necessity, expression-estimate hazards, 30-group upper bound, and linear scaling are offline. The 55k matches, estimate factors, worker strategy, buffers, and runtime are live.

---

## q10 — grouping-key predicate in HAVING

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `orders o` | index-backed; `bitmap-heap-scan` using `idx_orders_customer_id` is the leading candidate | exact range rows unavailable; low tens of thousands only if IDs are dense in the expected domain | `customer_id < 1000` constrains the grouping key and is legally pushable below aggregation on PostgreSQL 16. The exported stats do not include range histogram bounds, so ~9,990 is not independently derivable unless the IR already carries a supported selectivity. If the range is selective, low physical correlation and the need for `total_cents` make a bitmap heap scan more plausible than a simple/index-only scan. |

**Join strategies**

- None.

**Dominant costs, ranked**

1. Fetching the selective customer-id range's widely scattered heap tuples. The index lookup itself should be cheap; heap pages dominate because `total_cents` is not in the index and customer-id correlation is near zero.
2. Hash aggregation into the matching customer groups and applying `count(*) > 5`.
3. Everything else is negligible; there is no scan of all 2M orders to aggregate before the customer-id filter.

**Memory/spill**

- `memoryRisks: []` for the expected selective range. The live range/group count should be checked, but nothing in the IR/catalog supports predicting a spill.

**Estimation risks**

- **Unknown for the base range in the exported contract:** `nDistinct` does not encode numeric min/max or histogram bounds. If the IR has no independently supported selectivity, omit the exact row estimate.
- **Over/medium for post-HAVING groups:** the selectivity of `count(*) > 5` is not described by column stats; PostgreSQL may apply a generic aggregate-filter estimate.

**Scalability**

- Summary: `O(R_matching_orders + G_matching_customers)`, not O(all orders). As the customer-id threshold approaches a large table fraction, the path can change from bitmap heap scan to seq scan.

### PG16 sanity check

- PostgreSQL pushed `customer_id < 1000` to a bitmap index condition despite its placement in HAVING. Actual path: bitmap index scan (9,990 entries), bitmap heap scan (9,987 heap blocks), then one-batch hash aggregate.
- Heap access dominates: 10,001 shared hits, ~5.15 ms inclusive versus 0.476 ms for the bitmap index. Aggregate memory was 657kB.
- Base estimate was 9,761 vs 9,990 (excellent). Post-HAVING output was estimated 3,184 vs 999 (~3.2× high), but this did not hurt plan choice.
- Median total was **6.9 ms**. Moving the grouping-key predicate to WHERE may improve readability; the correct performance prediction is same access path and approximately zero speedup, pending verification—not a promised optimization.

**Offline/live boundary:** legal grouping-key pushdown, an index-backed candidate path, bitmap-vs-simple-index rationale if the range is selective, and a bounded aggregate are defensible from IR/catalog/version. The ~10k range count, exact bitmap plan, and same-plan rewrite claim should still be confirmed with `EXPLAIN`; buffers and 6.9 ms are live.

---

## q11 — correlated max for every outer order

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation/role | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| outer `orders o` | `index-scan` using `idx_orders_customer_id` | all 2M scanned; output uncertain, plausibly ~number of customers absent ties | The index supplies `ORDER BY customer_id`, so it can avoid a separate sort, but the filter must inspect every outer order. Required output columns force heap access. |
| inner `orders o2` | `index-scan` using `idx_orders_customer_id` | ~10 rows per outer row, one scalar max result | The correlated equality is indexed, but `created_at` is not stored in the index, so each invocation visits heap rows and aggregates them. |

**Join/subplan strategies**

- Correlated scalar aggregate, execution-equivalent to a parameterized `nested-loop`: **2M subplan invocations** are predicted, one per outer order. With ~10 orders/customer, about 20M inner order tuples are revisited.
- The same customer's maximum is recomputed for each of that customer's orders unless the runtime inserts a reuse mechanism; the current IR/catalog provide no basis to promise Memoize.

**Dominant costs, ranked**

1. The inner index/heap scan and max aggregate repeated 2M times. Evaluate by per-loop time × 2M, not the innocuous-looking per-loop milliseconds.
2. Outer index/heap scan of all 2M orders and filter comparison.
3. No explicit final sort should be needed if the customer-id index order is retained.

**Memory/spill**

- `memoryRisks: []`. Each max aggregate uses constant memory and there is no required sort in the likely plan. The risk is extreme buffer churn, not work_mem spill.

**Estimation risks**

- Average inner rows (~10) is predictable and likely accurate.
- **Under/high for outer result:** statistics do not encode “row equals its per-customer maximum” or timestamp ties. A generic equality estimate can be far below approximately one row/customer, while ties can produce more than one row/customer.

**Scalability**

- Summary: `O(N_orders log N_orders + Σ_customer k_customer²)`. Under uniform k this includes roughly N×k inner tuple visits. If customer count stays fixed while order history grows, the correlated work becomes quadratic per customer; if k stays fixed, it appears linear with a very large constant.

### PG16 sanity check

- Actual outer path was an ordered scan of `idx_orders_customer_id`; no sort node appeared.
- Inner aggregate and index scan ran **2,000,000 loops**, exactly 10 rows each on average: ~20M revisited tuples. The subplan produced **26,000,000 shared hits**; total plan traffic was **28,002,341 hits**.
- Per-loop inner index time was only ~0.002 ms and aggregate time ~0.003 ms, but multiplication by 2M explains several seconds. The outer scan removed 1.8M rows and returned 200k.
- Top estimate was 10,000 vs 200,000 (**20× low**); inner 10-row estimates were accurate. Median was **6,577.3 ms** (displayed run ~6.86 s). There was no spill; JIT was only ~32.5 ms.

**Offline/live boundary:** 2M loops, ~10 inner rows, lack of covering index, preserved order, and `Σk²` scaling are derivable. Exact output/ties, absence of Memoize, 28M buffer hits, and 6.6 s require live verification.

---

## q12 — JSON expression filter plus `count(DISTINCT)`

### Offline reference `ExecutionAnalysis`

**Access paths**

| Relation | Predicted path | Estimated rows | Reason |
|---|---|---:|---|
| `events e` | `seq-scan` (parallel likely) | omit final estimate; ~501k survive `event_type` before date/JSON filters | The event-type MCVs sum to ~10.02%, but no baseline index serves event type, date, or `payload->>'utm_source'`. The payload expression has no expression statistics and date histogram bounds are absent. All 5M rows must be visited. |

**Join strategies**

- None.

**Dominant costs, ranked**

1. Reading 5M event rows and evaluating the timestamp, event-type, and JSON extraction predicates. JSON extraction adds CPU, while the 770MB heap makes I/O/cache state decisive.
2. Ordering matching `customer_id` values so `count(DISTINCT customer_id)` can deduplicate within the group, followed by a group aggregate. A sort-based plan is plausible; exact hash-vs-sort choice needs the planner.
3. `GROUP BY payload->>'utm_source'` is effectively one group because the WHERE clause fixes it to `'email'`; the final `ORDER BY events` over one row is negligible.

**Memory/spill**

- Current spill cannot be predicted confidently because final match selectivity is missing. The distinct-input sort is the relevant operation: memory scales with matching rows per worker and can spill above `work_mem`. Do not claim the one-row final sort is the risk.

**Estimation risks**

- **Under/high:** no stats exist for the JSON text expression, and the catalog has no multivariate stats for `event_type`, date, and payload source. Multiplying generic independent selectivities can grossly undercount a correlated funnel subset.
- **Over for groups:** the expression equality proves at most one nonempty source group, even if generic expression ndistinct suggests more.

**Scalability**

- Summary: `O(N_events + M_matches log M_matches)` for the observed sorted-distinct plan, memory O(M_matches) until external sort. The full event scan grows linearly; a broader interval or more matching sources makes distinct sorting the next bottleneck.

### PG16 sanity check

- Actual plan: parallel seq scan, per-process quicksort by `customer_id`, `Gather Merge`, one `GroupAggregate` computing both counts, then a one-row quicksort.
- The scan returned **111,589 rows** total and removed ~4.89M. It reached ~160 ms and accounted for 80,347 buffers, including **76,154 reads**—the clear dominant cost.
- The scan estimate was 813 vs 37,196 rows per process (~46× low); `Gather Merge` estimated 1,951 vs 111,589 (~57× low). This is the corpus's strongest multicolumn/expression estimation failure.
- Worker sorts used ~4.9–5.0MB and stayed in memory. Sorting/gathering extended elapsed time to ~195 ms; distinct/group work then completed around 200 ms. The final one-row sort used 25kB. Median total was **195.5 ms**.
- The output contains one source and 20,000 distinct customers (111,589 matching events). Exact distinct count is a live data fact, not derivable from `events.customer_id.nDistinct` alone.

**Offline/live boundary:** full-scan path, ~501k event-type prefilter, expression/multivariate underestimate risk, one output group, and distinct-sort scaling are offline. The 111,589 matches, 20k customers, sort choice/memory, 76k reads, and 196 ms are live.

---

## Cross-query quality bar for an M3 implementation

An implementation matches this reference only if it does all of the following without corpus-specific branches:

1. **Calibrates “bad shape” separately from current elapsed time.** q02 and q03 are currently 22 ms and 31 ms; they are scaling warnings, not present emergencies. q11 is the genuinely catastrophic correlated case because it executes 2M subplans.
2. **Understands execution semantics, not just scan labels.** q05 is a nullable hashed SubPlan with a possible empty-result correctness failure, not a hash anti-join. q07 is demoted to an inner join and has no outer-join performance barrier. q10's grouping-key predicate is pushed below aggregation.
3. **Tracks fan-out magnitude.** q06 must predict roughly 5.1M join rows from 1.7M complete orders × ~3 items/order and connect that magnitude to both hash/aggregate cost and repeated revenue values.
4. **Ranks costs with loop multiplication and buffers.** q03's 2k loops are modest; q11's 2M loops and 26M inner hits dominate. q08's DISTINCT is semantically suspicious but the current order-items scan and index probes cost more than its in-memory sort.
5. **Does not hallucinate spills.** All twelve captured plans are in-memory at 32MB. q04, q06, q08, and q12 have credible growth/concurrency risks, but current `memoryRisks` must distinguish pressure from observed/predicted disk spill.
6. **Admits catalog limits.** Exact date-range, LIKE, JSON-expression, conditional-NULL, cross-table duplicate, and multivariate selectivity are unavailable. Optional estimates should be omitted or ranged instead of fabricated.
7. **Avoids false precision in plan choice.** Parallel worker count, hash-vs-nested-loop crossover, aggregate implementation, and exact milliseconds/buffers require `EXPLAIN`; an offline prediction should carry confidence and alternatives.

## Primary sources used

- [PostgreSQL 16 — Using EXPLAIN](https://www.postgresql.org/docs/16/using-explain.html): plan-tree interpretation, inclusive node times, per-loop averages, rows removed, buffers, sort/hash instrumentation, and the distinction between arbitrary cost units and elapsed milliseconds.
- [PostgreSQL 16 — Statistics Used by the Planner](https://www.postgresql.org/docs/16/planner-stats.html): approximate single-column statistics and why absent multivariate/expression statistics create selectivity errors.
- [PostgreSQL 16 — Resource Consumption](https://www.postgresql.org/docs/16/runtime-config-resource.html): `work_mem` applies per sort/hash operation and can be multiplied across operations/workers; hash operations use `hash_mem_multiplier`.
- [PostgreSQL 16 — Parallel Plans](https://www.postgresql.org/docs/16/parallel-plans.html): parallel seq scans, nested-loop inner scans, shared parallel hashes, and partial/final aggregation.
- [PostgreSQL 16 — Indexes and ORDER BY](https://www.postgresql.org/docs/16/indexes-ordering.html): matching btrees can avoid sorts and are especially valuable with LIMIT, while scanning a large fraction may favor seq-scan-plus-sort.

This document intentionally stops after Phase 1. It contains no M3 comparison, source audit, score, verdict, or `BIGGEST_GAP`.
