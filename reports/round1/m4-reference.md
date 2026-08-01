# M4 blind reference — anti-pattern and sargability findings

**Round:** 1  
**Phase:** 1 only (independent reference)  
**Server:** PostgreSQL 16.14  
**Contract:** `detectAntiPatterns(ir, catalog): Finding[]`

This reference was written before any M4 output or `src/antipatterns/*` source was
read. It is intentionally limited to M4's contract: identify the concrete defect,
attach evidence, calibrate its impact, and give one sentence of remediation. Exact
DDL and complete rewrites belong to M5/M6.

## Evidence and calibration rules

- Local `groundtruth/*.txt` plans are median-of-three captures with actual rows,
  loops, buffers, and execution time. Live read-only checks below were rerun against
  the same PostgreSQL 16.14 container on 2026-07-31.
- `critical` is reserved here for demonstrated wrong answers; `high` is a material
  intent defect or a costly/scaling performance defect; `medium` is measurable but
  not currently catastrophic; `low`/`info` marks a structural risk whose present
  plan is already reasonable.
- A function or operator in a predicate is not automatically non-sargable.
  PostgreSQL supports [indexes on expressions](https://www.postgresql.org/docs/16/indexes-expressional.html),
  and the exact operator, expression, collation, and available indexes determine
  whether a search condition can become an index condition.
- PostgreSQL 16 documents that a B-tree can support a constant pattern anchored at
  the start, but not `LIKE '%suffix'`; under a non-C locale the prefix case needs a
  pattern operator class. See [index types](https://www.postgresql.org/docs/16/indexes-types.html)
  and [operator classes](https://www.postgresql.org/docs/16/indexes-opclass.html).
- PostgreSQL's documented [`NOT IN` NULL semantics](https://www.postgresql.org/docs/16/functions-subquery.html),
  [outer-join predicate semantics](https://www.postgresql.org/docs/16/queries-table-expressions.html),
  and [`OFFSET` behavior](https://www.postgresql.org/docs/16/queries-limit.html)
  support the correctness/intent findings below. The live plans decide their impact
  on this database.
- JSON access-path claims are constrained by PostgreSQL 16's
  [JSON indexing documentation](https://www.postgresql.org/docs/16/datatype-json.html).
  In particular, the query's `->>` equality is not directly served by the existing
  JSONB primary-key-only catalog, but the extracted expression itself is immutable
  and can be indexed exactly.

## Ideal `Finding[]`, query by query

### q01 — monthly revenue via `date_trunc`

```ts
[
  {
    id: "non-sargable-function-on-timestamptz",
    title: "date_trunc prevents a raw created_at range scan",
    severity: "medium",
    category: "performance",
    evidence: {
      sqlFragment: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'",
      relation: "orders",
      column: "created_at"
    },
    impact: "The PostgreSQL 16 plan performs a Parallel Seq Scan over all 2,000,000 orders, removes 650,521 rows per worker (1,951,563 total), emits 48,437 matches, and runs in a 111.7 ms median. The validated plain (status, created_at) index alone remains unused because the predicate does not constrain raw created_at.",
    remediation: "Express the month as an explicit half-open range on o.created_at, with the intended time zone made explicit.",
    caveat: "An exactly matching immutable expression can be indexed, but the two-argument date_trunc(text, timestamptz) used here is STABLE because it depends on session TimeZone; on a small table a scan can still be rational.",
    confidence: "high"
  }
]
```

Do not turn the time-zone caveat into a claim that the query is currently wrong:
its calendar-month semantics are valid if the session time zone is intentional.

### q02 — suffix search OR prefix search

```ts
[
  {
    id: "leading-wildcard-like",
    title: "Leading-wildcard email search has no B-tree search prefix",
    severity: "low",
    category: "performance",
    evidence: {
      sqlFragment: "email LIKE '%@example.com'",
      relation: "customers",
      column: "email"
    },
    impact: "A normal B-tree cannot narrow this suffix pattern. Here the literal matches 200,000 of 200,000 customers, so the Parallel Seq Scan and 22.4 ms median are already well calibrated; this is a scaling/search-shape risk, not evidence that an index would improve the current literal.",
    remediation: "Use a suffix-capable search path only when production patterns are selective enough for it to beat a scan.",
    caveat: "Do not apply this finding to full_name LIKE 'Customer 1%': that pattern is anchored and B-tree-searchable with the appropriate pattern operator class under this database's en_US.utf8 collation.",
    confidence: "high"
  },
  {
    id: "mixed-access-paths-under-or",
    title: "OR combines search branches with different indexability",
    severity: "info",
    category: "performance",
    evidence: {
      sqlFragment: "email LIKE '%@example.com' OR full_name LIKE 'Customer 1%'",
      relation: "customers"
    },
    impact: "The prefix branch matches 111,111 rows, while the suffix branch matches every row, so the OR also matches all 200,000 rows and the top-N sort must consider the full result. No single ordinary B-tree serves both columns, but the OR keyword itself is not inherently non-indexable.",
    remediation: "Treat the two search modes as distinct access-path requirements and only separate them when duplicate handling and the global ORDER BY/LIMIT semantics are preserved.",
    caveat: "PostgreSQL can combine independently usable indexes with a BitmapOr; rewriting to UNION is not automatically faster and can change duplicate or top-50 semantics.",
    confidence: "high"
  }
]
```

The anchored `full_name` predicate must not receive a generic "leading wildcard" or
"function on column" finding.

### q03 — two correlated per-customer aggregates

```ts
[
  {
    id: "repeated-correlated-aggregate-scans",
    title: "Two correlated aggregates rescan each selected customer's orders",
    severity: "low",
    category: "performance",
    evidence: {
      sqlFragment: "(SELECT count(*) FROM shop.orders o WHERE o.customer_id = c.customer_id), (SELECT max(o2.created_at) FROM shop.orders o2 WHERE o2.customer_id = c.customer_id)",
      relation: "orders",
      column: "customer_id"
    },
    impact: "Only 2,000 of 200,000 customers are gold, and idx_orders_customer_id makes both subplans cheap: each runs 2,000 times over about 10 rows, for 32,001 subplan buffer hits and a 31.5 ms median. The duplicate work is real, but present cost is modest; it grows linearly with qualifying customers and performs the same per-customer lookup twice.",
    remediation: "Compute count and maximum together per selected customer while preserving customers with zero orders and the different zero/NULL aggregate results.",
    caveat: "Correlated execution is not categorically slow: this selective outer input plus the existing index performs well, and pre-aggregating all 2,000,000 orders could be slower at today's 1% outer selectivity.",
    confidence: "high"
  }
]
```

### q04 — deep `OFFSET` pagination

```ts
[
  {
    id: "deep-offset-pagination",
    title: "OFFSET makes page cost grow with page depth",
    severity: "high",
    category: "performance",
    evidence: {
      sqlFragment: "ORDER BY o.created_at DESC, o.order_id DESC LIMIT 20 OFFSET 100000",
      relation: "orders",
      column: "created_at"
    },
    impact: "PostgreSQL must produce 100,020 ordered rows to return 20 and discard the first 100,000. The captured plan processes 1,700,000 complete-order join rows, uses about 20 MB for each worker's top-N heap, and runs in a 392.5 ms median; deeper pages increase the retained/discarded prefix linearly.",
    remediation: "Use cursor/seek pagination on the deterministic (created_at, order_id) order when the product does not require arbitrary page jumps.",
    caveat: "OFFSET is semantically appropriate for small offsets or true random page access; seek pagination changes the API and snapshot/concurrency behavior and is not a drop-in promise.",
    confidence: "high"
  }
]
```

The unique `order_id` tie-breaker is already present, so there is no unstable-order
finding here.

### q05 — `NOT IN` over a nullable key

```ts
[
  {
    id: "not-in-nullable-subquery",
    title: "Nullable NOT IN subquery makes the anti-filter return no rows",
    severity: "critical",
    category: "correctness",
    evidence: {
      sqlFragment: "c.customer_id NOT IN (SELECT e.customer_id FROM shop.events e WHERE e.event_type = 'checkout')",
      relation: "events",
      column: "customer_id"
    },
    impact: "events.customer_id is nullable (catalog nullFrac 0.1450), and the live checkout set contains 14,285 NULLs among 100,000 rows. One NULL makes NOT IN unknown for every otherwise-unmatched customer: the plan removes all 200,000 customer rows and returns 0, whereas null-safe anti-membership returns 196,000. The 148.6 ms full events scan is secondary to the wrong answer.",
    remediation: "Use a null-safe anti-membership test correlated on e.customer_id = c.customer_id.",
    caveat: "NOT IN is safe when both the compared value and every subquery output are proven non-NULL; that proof does not hold for events.customer_id here.",
    confidence: "high"
  }
]
```

This finding must be first in any cross-query priority order. Reporting only the
hashed subplan or missing index is a material failure.

### q06 — fan-out double-counts order revenue

```ts
[
  {
    id: "aggregate-over-one-to-many-fanout",
    title: "Item fan-out triples SUM(order.total_cents)",
    severity: "critical",
    category: "correctness",
    evidence: {
      sqlFragment: "JOIN shop.order_items oi ON oi.order_id = o.order_id ... sum(o.total_cents) AS revenue_cents",
      relation: "order_items",
      column: "order_id"
    },
    impact: "The 1,700,000 complete orders become 5,100,000 order-item rows before aggregation. Live totals prove the result is wrong: correct order-grain revenue is 426,700,700,000 cents, while this query reports 1,280,102,100,000 cents, exactly 3.0000x too much. The plan's 2.4 s runtime and 5.1M aggregate input rows are secondary consequences of the same fan-out.",
    remediation: "Keep revenue aggregation at order grain by removing the unused item join or reducing item detail before it can multiply order values.",
    caveat: "A one-to-many join is safe for aggregates of item-level values or when the right side is proven unique on the join key; SUM(DISTINCT o.total_cents) is not a general repair because different orders can share a total.",
    confidence: "high"
  }
]
```

`count(*) AS item_count` is consistent with item-grain counting and should not be
called wrong without an external requirement that it mean order count.

### q07 — null-rejecting filter after `LEFT JOIN`

```ts
[
  {
    id: "left-join-null-rejected-in-where",
    title: "WHERE predicate erases LEFT JOIN preservation",
    severity: "high",
    category: "intent",
    evidence: {
      sqlFragment: "LEFT JOIN shop.orders o ON o.customer_id = c.customer_id WHERE o.status = 'complete'",
      relation: "orders",
      column: "status"
    },
    impact: "o.status = 'complete' is false/unknown for each NULL-extended order row, so the query cannot retain customers without a complete order. PostgreSQL confirms the demotion by planning a plain Nested Loop rather than a left join. Of 17,400 customers meeting signup_date >= 2024-01-01, 2,500 have no complete order and are omitted; runtime is a reasonable 88.2 ms, so the defect is result intent rather than plan cost.",
    remediation: "Decide the intended population: constrain status in the ON clause to preserve all customers, or spell INNER JOIN explicitly if only matched customers belong.",
    caveat: "If the real requirement is only customers with complete orders, the current rows are correct and PostgreSQL has already optimized the join; only the misleading LEFT spelling remains.",
    confidence: "high"
  }
]
```

The structured category is `intent`, not `performance`: SQL alone cannot prove which
of the two populations the author meant, but it can prove that `LEFT` does not deliver
its advertised preservation.

### q08 — `DISTINCT` collapses a join fan-out

```ts
[
  {
    id: "distinct-collapses-existence-fanout",
    title: "DISTINCT repairs duplicates created by an existence-only join",
    severity: "medium",
    category: "performance",
    evidence: {
      sqlFragment: "SELECT DISTINCT c.customer_id, c.email, c.loyalty_tier ... JOIN shop.order_items oi ... JOIN shop.products p ...",
      relation: "order_items",
      column: "order_id"
    },
    impact: "Only customer columns are projected, yet the joins materialize 19,935 qualifying item/order paths for 3,000 customers and then sort/unique them. The captured plan scans all ~6.0M order_items, touches about 246k buffers, and runs in a 296.1 ms median; DISTINCT is evidence that the intended test is existence, although the unindexed item scan is the larger present cost.",
    remediation: "Express the joined-side condition as an existence/semi-join test so customer output does not depend on generating and collapsing every matching path.",
    caveat: "DISTINCT can be intentional when joined-side values affect the selected grain, and a semi-join does not guarantee per-customer early exit: on this baseline PostgreSQL still scans all order_items to build the matching side, so do not promise a measured speedup without the complete access-path plan.",
    confidence: "high"
  }
]
```

### q09 — `timestamptz::date` in the filter

```ts
[
  {
    id: "non-sargable-cast-on-timestamptz",
    title: "Casting created_at to date blocks a raw timestamp range condition",
    severity: "medium",
    category: "performance",
    evidence: {
      sqlFragment: "o.created_at::date BETWEEN DATE '2024-06-01' AND DATE '2024-06-30'",
      relation: "orders",
      column: "created_at"
    },
    impact: "The plan performs a Parallel Seq Scan of all 2,000,000 orders, removes 648,284 rows per worker (1,944,852 total), and keeps 55,149 June rows; median runtime is 81.4 ms. A normal B-tree on raw created_at cannot become an Index Cond for this cast, and date(timestamptz) is STABLE because its value depends on session TimeZone.",
    remediation: "Filter raw o.created_at with an explicit half-open timestamp range in the intended time zone while leaving the display/grouping cast separate.",
    caveat: "An exactly matching time-zone-fixed immutable expression could be indexed if date semantics must remain expression-based; a scan can also be correct for a broad range or small table.",
    confidence: "high"
  }
]
```

The half-open upper boundary must be July 1, not an inclusive timestamp at June 30.

### q10 — grouping-key predicate in `HAVING`

```ts
[]
```

There is **no performance finding**. PostgreSQL 16 pushes `o.customer_id < 1000`
into the `Bitmap Index Scan` on `idx_orders_customer_id`, reads 9,990 of 2,000,000
orders, leaves only `count(*) > 5` as the aggregate filter, and finishes in a 6.9 ms
median. The pushdown is legal because `customer_id` is the grouping key. The generic
rule "HAVING filters after aggregation, therefore move this to WHERE for speed" is
confidently wrong for this plan.

An implementation may optionally emit the following **intent/readability-only** note;
omitting it is equally acceptable:

```ts
{
  id: "grouping-key-filter-in-having",
  title: "Grouping-key filter is clearer in WHERE but already pushed down",
  severity: "info",
  category: "intent",
  evidence: {
    sqlFragment: "HAVING count(*) > 5 AND o.customer_id < 1000",
    relation: "orders",
    column: "customer_id"
  },
  impact: "PostgreSQL 16 already applies customer_id < 1000 as a Bitmap Index Cond and runs in 6.9 ms; moving it is a readability change with approximately zero expected performance benefit.",
  remediation: "Move only the grouping-key predicate to WHERE if separating row filters from aggregate filters improves readability.",
  caveat: "Do not generalize the observed pushdown to predicates on non-grouping columns, and do not claim a speedup for this query.",
  confidence: "high"
}
```

### q11 — correlated maximum at full outer cardinality

```ts
[
  {
    id: "full-cardinality-correlated-aggregate",
    title: "Correlated max executes once for every order row",
    severity: "high",
    category: "performance",
    evidence: {
      sqlFragment: "o.created_at = (SELECT max(o2.created_at) FROM shop.orders o2 WHERE o2.customer_id = o.customer_id)",
      relation: "orders",
      column: "customer_id"
    },
    impact: "Unlike q03's selective 2,000-row outer input, this outer index scan visits all 2,000,000 orders and executes the aggregate subplan 2,000,000 times. Each execution scans about 10 sibling orders, producing 26,000,000 subplan buffer hits (28,002,341 total), removing 1,800,000 outer rows, and taking a 6.58 s median. Cost scales with outer orders multiplied by orders per customer.",
    remediation: "Compute the latest timestamp per customer setwise and make the desired behavior for equal timestamps explicit.",
    caveat: "The current equality returns every order tied for a customer's maximum timestamp; a one-row-per-customer rewrite is not equivalent unless a deterministic tie-break rule is an accepted requirement.",
    confidence: "high"
  }
]
```

This and q03 are deliberately the same structural rule with different severity. A
detector that calls every correlated subquery `high`, or both of them harmless, is
not calibrated to the actual outer cardinality and plan loops.

### q12 — extracted JSON key plus constant grouping

```ts
[
  {
    id: "unindexed-json-scalar-extraction",
    title: "JSON scalar equality has no matching access path",
    severity: "medium",
    category: "performance",
    evidence: {
      sqlFragment: "e.payload->>'utm_source' = 'email'",
      relation: "events",
      column: "payload"
    },
    impact: "events has 5,000,022 rows and only its primary-key index. The plan evaluates all three filters in a Parallel Seq Scan, removes 1,629,470 rows per worker (4,888,410 total), emits 111,589 events, touches about 80k buffers, and runs in a 195.5 ms median. It also estimates only about 2,439 surviving rows, roughly 46x low, because catalog statistics do not describe the extracted key together with event_type/time.",
    remediation: "Make the exact extracted text value a searchable, statistically visible attribute when this filter is a recurring selective workload.",
    caveat: "The ->> expression is immutable and can be indexed exactly, so it is not intrinsically unsargable; because event_type and occurred_at also lack supporting paths, changing only this expression may still leave a scan and must not carry a guaranteed speedup.",
    confidence: "high"
  },
  {
    id: "group-by-filtered-constant",
    title: "GROUP BY repeats a value fixed by WHERE",
    severity: "info",
    category: "intent",
    evidence: {
      sqlFragment: "WHERE e.payload->>'utm_source' = 'email' ... GROUP BY 1 ORDER BY events DESC",
      relation: "events",
      column: "payload"
    },
    impact: "The equality predicate proves the projected group key can only be 'email', so this query returns at most one group (one row in the live result) and sorting that single group uses only 25 kB. This is a result-shape/readability smell, not the cause of the 195.5 ms scan; count(DISTINCT customer_id) still requires distinct aggregation over 111,589 events for 20,000 customers.",
    remediation: "Choose explicitly between a multi-source breakdown (do not fix source to one value) and a one-row summary whose empty-input behavior is defined.",
    caveat: "Removing GROUP BY is not perfectly equivalent on an empty input: the current grouped query returns zero rows, while an ungrouped aggregate returns one row with zero counts; template consistency can also make the redundant shape intentional.",
    confidence: "high"
  }
]
```

## Cross-query priority

If all findings are rendered in one report, the ideal ordering is:

1. q05 nullable `NOT IN` and q06 fan-out revenue inflation (`critical`, correctness).
2. q07 left-join intent loss (`high`, intent).
3. q11 full-cardinality correlation and q04 deep offset (`high`, performance).
4. q01/q09 expression-wrapped timestamp filters, q08 existence fan-out, and q12
   unindexed JSON extraction (`medium`, performance).
5. q03's currently cheap correlated scans (`low`, performance), then q02 and q12
   informational/calibration notes.
6. q10 contributes no performance finding; an optional readability note is last.

No comparison, source-code inspection, score, or verdict is included because those
belong to later critic phases.
