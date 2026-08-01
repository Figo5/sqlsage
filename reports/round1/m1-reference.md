# M1 blind reference — schema-bound query IR

**Round:** 1  
**Phase:** 1 only (independent reference)  
**Target contract:** `bindQuery(sql, catalog): QueryIR` from `src/types.ts`  
**Database checked:** PostgreSQL 16.14, live `sage` database, 2026-07-31

This reference was written before reading `src/ir/*`, before running `bindQuery`, and
before inspecting any M1 output. It is a structural yardstick, not a comparison or a
score.

## Evidence and interpretation rules

The reference uses the corpus SQL, schema, refreshed catalog, refreshed text plans,
and targeted read-only/live checks. The authoritative PostgreSQL semantics used here
are:

- [Table expressions](https://www.postgresql.org/docs/16/queries-table-expressions.html):
  aliases define scope; outer-query scope reaches into correlated subqueries; and an
  outer-join predicate in `ON` is semantically different from the same predicate in
  `WHERE`.
- [Subquery expressions](https://www.postgresql.org/docs/16/functions-subquery.html):
  correlated outer values act as constants during one subquery evaluation, and
  `NOT IN` can evaluate to null when the right-hand result contains a null.
- [SELECT](https://www.postgresql.org/docs/16/sql-select.html): output aliases and
  ordinals are legal in `ORDER BY`/`GROUP BY`; `GROUP BY` can contain expressions; and
  `ORDER BY` resolves an ambiguous simple name as an output name while `GROUP BY`
  prefers an input name.
- [Operator classes](https://www.postgresql.org/docs/16/indexes-opclass.html) and
  [expression indexes](https://www.postgresql.org/docs/16/indexes-expressional.html):
  pattern and expression predicates need the right access method/operator class or an
  exact expression index; merely finding a referenced base column is not enough.

The live database is `en_US.utf8`, timezone `Etc/UTC`. A rolled-back probe showed that
an ordinary btree on `customers(full_name)` could not form index bounds for
`LIKE 'Customer 1%'`, while `full_name text_pattern_ops` produced bounds from
`Customer 1` through `Customer 2`. The refreshed plans are the execution sanity
checks; M1 itself should not ingest those plans.

### Canonical IR invariants

For every query below:

- `dialect = 'postgres'`, `statementType = 'select'`, the root is a select block, and
  `bindingErrors = []`. An output alias or `GROUP BY 1` is not a binding error.
- Block ids may differ from the illustrative `main`, `sub:1`, and `sub:2`, but they
  must be stable, unique, and identify the same containment/correlation graph.
- A `ResolvedColumnRef` must retain the alias as written, concrete base table,
  column, and catalog type. Subquery-local columns stay in their subquery block;
  cross-scope references additionally appear in `correlationRefs`.
- Join type and predicate placement are syntactic-semantic facts. Planner rewrites
  must not turn the IR's q07 `LEFT JOIN` into an `INNER JOIN`, or turn q10's grouped-key
  `HAVING` predicate into a syntactic `WHERE` predicate.
- `fanOut` is judged in the stated left-to-right SQL join orientation: it is true
  when the right input is not unique on the equijoin key. An equivalent orientation
  is acceptable only if its uniqueness reasoning carries the same information.
- `sargable` describes predicate shape, not whether a suitable index currently
  exists. Bare equality/range/IN predicates are sargable; a leading-wildcard btree
  predicate, a cast/function around the indexed operand, an aggregate filter, or a
  scalar-subquery comparison is not. A prefix `LIKE` under this non-C collation is
  sargable only with the `text_pattern_ops` qualification in its reason.
- The block `predicates` inventory should preserve WHERE logic; `having` preserves
  HAVING logic; equijoin keys live in `joins`; and `RelationIR.localPredicates`
  identifies predicates safe to apply at that relation. Duplication between a block
  inventory and `localPredicates` is acceptable if object meaning remains consistent.
- Conjuncts may be separate predicate records. Disjuncts must not be flattened in a
  way that loses `OR`. q02 therefore needs one compound Boolean predicate in the
  current contract, with branch-specific facts retained in its reason.
- `selectivity` is optional. It should be populated only when the supplied catalog
  supports it. MCV-backed values below are defensible; inventing precision for date
  ranges or patterns is not.
- `windowFunctions = []` and `setOp` is absent for all 12 queries. `distinct` is true
  only for q08; aggregate-local `DISTINCT` in q12 belongs on the aggregate record.
- An omitted sort direction means `asc`. None of these queries writes an explicit
  `NULLS` mode, so leaving `orderBy[].nulls` absent is more faithful than synthesizing
  one.

### Catalog facts M1 must reason from

| Relation | Rows | Key/uniqueness facts relevant here |
|---|---:|---|
| `shop.customers` | 200,000 | `customer_id` primary key; `loyalty_tier='gold'` MCV 0.009766666 |
| `shop.orders` | 2,000,000 | `order_id` primary key; non-unique btree on `customer_id`; `status='complete'` MCV 0.8499333 |
| `shop.order_items` | 6,000,000 | `order_item_id` primary key; non-unique btree on `order_id`; live average exactly 3 rows/order |
| `shop.products` | 50,000 | `product_id` primary key; `category_id` has about 200 values and is not unique |
| `shop.events` | 5,000,022 estimate | `event_id` primary key; `customer_id` nullable (`nullFrac` 0.14503333); checkout MCV 0.018666666 |

During Phase 1, the first refreshed `corpus/catalog.json` exposed a foundation defect:
`primaryKey`, `foreignKeys[].columns`, and `foreignKeys[].referencesColumns` were
PostgreSQL brace strings such as `"{customer_id}"`, while `src/types.ts` requires
`string[]`. The collector was corrected and the catalog regenerated during this blind
phase; the current file now contains validated arrays and is the input used by this
reference. The incident still establishes an important boundary invariant: malformed
constraint shapes must be normalized or rejected, never silently interpreted as loss
of uniqueness that turns every join into fan-out.

### Expressiveness limits in the current shared contract

These are properties of the Phase-1 yardstick, not findings against an implementation:

1. `Predicate` has no Boolean child tree, so q02 cannot represent both the `OR`
   topology and each leaf's structured sargability without an extension.
2. `ResolvedColumnRef` has no nullability field, so q05's crucial nullable subquery
   output is recoverable only by joining the resolved table/column back to `Catalog`.
3. `groupBy` stores only column refs, not expression SQL or output references. It loses
   the cast in q09 and the `payload->>` expression/ordinal in q12 unless another field
   or explicit extension preserves it.
4. `orderBy.column` cannot represent an output-expression alias. For q01, q03, q06,
   q09, and q12, `column: null` plus exact `sql` is the honest contract-level encoding;
   those valid aliases must not create binding errors.
5. A projection containing a scalar subquery has no typed link to its subquery block.
   The block graph and projection SQL must therefore remain stable enough to associate
   q03/q11 expressions with their blocks.

## q01 — non-sargable `date_trunc`

### Blocks, relations, and join

- One root select block (`main`).
- Relations: `o -> shop.orders` and `c -> shop.customers`, both `kind='table'`.
- Inner join `o` to `c` on `o.customer_id = c.customer_id`.
- Equikey refs resolve to `orders.customer_id bigint` and
  `customers.customer_id bigint`.
- `fanOut=false`: the right-side `customers.customer_id` is a primary key. The real
  plan independently reports `Inner Unique: true`.

### Predicates

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'` | `where` / `equality` | `o -> orders.created_at` (`timestamp with time zone`) | no | `date_trunc` wraps the table column, so a normal btree on raw `created_at` cannot form an index condition; an exact expression index would be a different access path |
| `o.status = 'complete'` | `where` / `equality` | `o -> orders.status` (`text`) | yes | bare-column equality; existing-index availability is separate; catalog selectivity 0.8499333 |

Both are local to `o`; the conjunction must remain AND. The refreshed plan confirms a
parallel sequential scan with the combined filter and 650,521 rows removed per loop.

### Projection and shape

- Projections: `c.country_code`; `count(*) AS order_count` (no referenced column);
  `sum(o.total_cents) AS revenue_cents` (resolved `orders.total_cents bigint`).
- `groupBy = [c.country_code]`.
- Aggregates: `count(*)` and `sum(o.total_cents)`, neither distinct.
- `orderBy = [{sql:'revenue_cents', column:null, direction:'desc'}]`; this is the
  aggregate output alias, not a missing base column.
- No limit, offset, distinct, subquery, correlation, or window.

The IR must preserve the typed timestamptz literal and the function-wrapped operand;
reducing the filter to a generic equality on `created_at` would erase the reason the
plan scans the table.

## q02 — leading-wildcard search plus heterogeneous OR

### Blocks and relation

- One root select block.
- One unaliased `shop.customers` table relation. Its relation alias is `customers`;
  unqualified projected/filter columns resolve unambiguously to that base table.
- No joins or correlation.

### Predicate

The current contract's minimum faithful record is the complete WHERE expression:

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `email LIKE '%@example.com' OR full_name LIKE 'Customer 1%'` | `where` / `boolean` | `customers.email`, `customers.full_name` (both `text`) | no, as a compound btree predicate | preserve OR; the email leaf is `like-infix`, non-sargable for btree because of the leading `%`; the full-name leaf is `like-prefix`, indexable under live `en_US.utf8` with `text_pattern_ops`; the branches need different access paths |

It is acceptable to add structured leaf records only if their parent/disjunction is
also preserved. It is not acceptable to emit two flat predicates that downstream
code could interpret as AND. The full compound predicate is local to `customers`.

### Projection and shape

- Projections resolve `customer_id bigint`, `email text`, and `full_name text` to
  `customers`; no aliases.
- `orderBy` resolves bare input `signup_date date`, descending.
- `limit=50`; no offset, distinct, aggregation, grouping, subquery, or window.

The refreshed plan's full parallel scan and 200,000 matched rows validate why an IR
must not label the whole OR simply “prefix-like and sargable.”

## q03 — two correlated scalar aggregate subqueries

### Block graph and binding

- Three select blocks: root `main`, plus two distinct scalar-subquery blocks. They
  must not be merged merely because both read `orders`.
- Root relation: `c -> shop.customers`.
- Subquery 1 relation: `o -> shop.orders`; `correlated=true` with
  `correlationRefs=[c.customer_id]` resolved to the enclosing customers relation.
- Subquery 2 relation: `o2 -> shop.orders`; `correlated=true` with the same outer ref.
- Root itself is not correlated. There are no ordinary `JoinIR` records; the
  cross-scope equalities remain correlated subquery predicates.

### Predicates

| Block / SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| root: `c.loyalty_tier = 'gold'` | `where` / `equality` | `c -> customers.loyalty_tier text` | yes | bare equality; MCV selectivity 0.009766666 |
| subquery 1: `o.customer_id = c.customer_id` | `where` / `join` | inner `orders.customer_id bigint`; outer `customers.customer_id bigint` | yes on inner | during each correlated evaluation the outer value acts as a parameter; the inner bare key can use the non-unique customer-id btree |
| subquery 2: `o2.customer_id = c.customer_id` | `where` / `join` | inner `orders.customer_id bigint`; outer `customers.customer_id bigint` | yes on inner | same reasoning, with independent alias/scope |

Each subquery's equality is local as an access restriction on its inner relation but
must still retain the outer binding and correlation flag.

### Projection and shape

- Root projections: `c.customer_id`, `c.email`, scalar subquery 1 as `order_count`,
  scalar subquery 2 as `last_order_at`.
- Subquery 1 projects/records aggregate `count(*)`; subquery 2 projects/records
  `max(o2.created_at)` with `o2.created_at` resolved.
- Root `orderBy` is output alias `order_count DESC`, so `column:null` plus exact SQL;
  this is not a binding failure.
- No grouping, limit, offset, distinct, or windows in any block.

Important retained semantics: these are scalar aggregates (one value per outer row),
`count(*)` yields zero for no matches while `max` yields null, and each subquery has an
independent correlated evaluation. The real plan shows both subplans looping 2,000
times, confirming the block/correlation model.

## q04 — deep OFFSET over a deterministic composite order

### Blocks, relations, and join

- One root select block with `o -> orders` and `c -> customers`.
- Inner join on `o.customer_id = c.customer_id`; both bigint refs resolve.
- `fanOut=false` in SQL orientation `o -> c` because the right key is the customers
  primary key (`Inner Unique: true` in the plan).

### Predicate

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `o.status = 'complete'` | `where` / `equality` | `orders.status text` | yes | bare equality; MCV selectivity 0.8499333 |

This is local to `o`.

### Projection and shape

- Projections resolve `o.order_id bigint`, `o.created_at timestamptz`,
  `o.total_cents bigint`, and `c.email text`.
- Ordered by two resolved base refs in exact sequence:
  `o.created_at DESC`, then `o.order_id DESC`.
- `limit=20`, `offset=100000` (numeric, not silently discarded).
- No grouping, aggregates, distinct, subqueries, or windows.

The pair order and the large offset are semantic inputs for downstream keyset advice;
representing only the first sort key or only the limit is incomplete.

## q05 — nullable `NOT IN` subquery

### Block graph and binding

- Two select blocks: root `main` over `c -> customers`, and one non-correlated
  subquery over `e -> events`.
- The subquery projection is exactly `e.customer_id`, resolved to
  `events.customer_id bigint`. The schema/catalog says this column is nullable.
- Neither block is correlated; there are no JoinIR records and specifically no
  logical anti-join lowering. `NOT IN` with a nullable right side is not an anti-join
  semantic equivalent.

### Predicates

| Block / SQL | Clause/kind | Columns | Sargable | Other required structure |
|---|---|---|---|---|
| root: `c.customer_id NOT IN (<subquery>)` | `where` / `subquery` | direct outer ref `c -> customers.customer_id bigint` | no | `negated=true`; retain link/containment to the subquery rather than treating it as an in-list of literals |
| subquery: `e.event_type = 'checkout'` | `where` / `equality` | `e -> events.event_type text` | yes | local to events; MCV selectivity 0.018666666 |

The nullable right-hand projection is the critical semantic structure even though
`ResolvedColumnRef` lacks a nullability property. Its table/column binding must be
precise enough for downstream code to recover `nullable=true` from the catalog.

### Projection and shape

- Root projects `c.customer_id` and `c.email`; subquery projects `e.customer_id`.
- No group, aggregate, order, limit, offset, distinct, or window.

Live facts: 100,000 checkout rows include 14,285 null customer ids; the plan uses a
hashed subplan and removes all 200,000 customers. The IR must not erase `NOT`, the
subquery output column, or its nullable base binding.

## q06 — two one-to-many joins before aggregation

### Blocks, relations, and joins

- One root select block with `c -> customers`, `o -> orders`, and
  `oi -> order_items`.
- Inner join `c.customer_id = o.customer_id`:
  `fanOut=true` because right-side `orders.customer_id` is non-unique (roughly ten
  orders per customer in this corpus).
- Inner join `o.order_id = oi.order_id`:
  `fanOut=true` because right-side `order_items.order_id` is non-unique. The live data
  has exactly 6,000,000 item rows for 2,000,000 order ids, or 3.0000 items/order.
- Both joins have one bigint equikey pair and no residual predicate.

The second fan-out is load-bearing: every `o.total_cents` value is repeated once per
item before `sum` runs. A false fan-out verdict would prevent downstream modules from
recognizing the correctness defect.

### Predicate

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `o.status = 'complete'` | `where` / `equality` | `o -> orders.status text` | yes | bare equality; local to orders; MCV selectivity 0.8499333 |

### Projection and shape

- Projections: `c.customer_id`, `c.email`, `sum(o.total_cents) AS revenue_cents`,
  and `count(*) AS item_count`.
- `groupBy` preserves both written refs, `[c.customer_id, c.email]`, even though the
  planner can exploit functional dependency and display only the primary key.
- Aggregates: non-distinct `sum(o.total_cents)` and non-distinct `count(*)`.
- `orderBy` is output alias `revenue_cents DESC` (`column:null`, exact SQL).
- `limit=100`; no offset, distinct, subquery, or window.

Important retained semantics: `sum` consumes an orders-grain value after item-grain
fan-out, while `count(*)` counts joined item rows. The plan confirms 5.1 million joined
rows from 1.7 million complete orders and reports the customer side inner-unique.

## q07 — LEFT JOIN whose right-side filter is in WHERE

### Blocks, relations, and join

- One root block with `c -> customers` and `o -> orders`.
- The IR join type remains `left`, with equikey
  `c.customer_id = o.customer_id` (bigint to bigint).
- `fanOut=true` because the right-side `orders.customer_id` is non-unique. A customer
  can have many matching orders.

### Predicates

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `o.status = 'complete'` | `where` / `equality` | `o -> orders.status text` | yes as an atomic access predicate | bare equality, but syntactically post-join and null-rejecting; it must not be mislabeled as `on`; MCV 0.8499333 |
| `c.signup_date >= DATE '2024-01-01'` | `where` / `range` | `c -> customers.signup_date date` | yes | bare range with correctly typed date literal |

Both reference one base relation and can appear in the respective relation's
`localPredicates`, but their original `clause='where'` must survive. In particular,
localizing `o.status` must not imply that it was written inside the ON condition.

### Projection and shape

- Projections resolve `c.customer_id`, `c.email`, `o.order_id`, and `o.total_cents`.
- No group, aggregate, order, limit, offset, distinct, subquery, or window.

The crucial semantic combination is `JoinIR.type='left'` plus a WHERE predicate on
the nullable/right side. PostgreSQL's real plan legally demotes it and shows a plain
nested loop; M1 must preserve the source semantics that make that transformation and
its correctness implications visible.

## q08 — DISTINCT after a fan-out chain

### Blocks, relations, and joins

- One root block with `c -> customers`, `o -> orders`, `oi -> order_items`, and
  `p -> products`.
- `c.customer_id = o.customer_id`: inner, `fanOut=true` because orders.customer_id
  is non-unique.
- `o.order_id = oi.order_id`: inner, `fanOut=true` because order_items.order_id is
  non-unique (three rows/order live).
- `oi.product_id = p.product_id`: inner, `fanOut=false` because the right-side
  products key is primary/unique.
- Each is a bigint equikey with no residual predicate.

### Predicates

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `p.category_id = 42` | `where` / `equality` | `p -> products.category_id integer` | yes | bare equality; no existing supporting index does not change predicate shape; approximate selectivity 1/200 is defensible |
| `o.created_at >= TIMESTAMPTZ '2024-01-01'` | `where` / `range` | `o -> orders.created_at timestamptz` | yes | bare range with a typed literal |

Each is local to its named relation.

### Projection and shape

- Projections resolve only customer-grain columns: `c.customer_id`, `c.email`, and
  `c.loyalty_tier`.
- `distinct=true` for the root block. This is row-level SELECT DISTINCT, not an
  aggregate-local flag.
- No grouping, aggregate, order, limit, offset, subquery, or window.

The pairing of two fan-out joins with a projection containing only customer columns
and root `distinct=true` is the important structure. The plan materializes about
19,935 qualifying item paths before producing 3,000 unique customers; the IR must not
mistake DISTINCT for a uniqueness guarantee on either join key.

## q09 — `timestamptz::date` in filter and grouping expression

### Blocks and relation

- One root block with `o -> orders`; no joins or correlation.

### Predicate

Preferred single-record representation:

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `o.created_at::date BETWEEN DATE '2024-06-01' AND DATE '2024-06-30'` | `where` / `range` | `o -> orders.created_at timestamptz` | no | the cast wraps the table operand, so raw `created_at` btree bounds cannot be formed; preserve BETWEEN's inclusive lower and upper endpoints |

Normalizing this to separate `>=` and `<=` records is equivalent only if both remain
non-sargable for the same cast reason and their conjunction/inclusive bounds survive.
The predicate is local to orders. The plan confirms a parallel sequential scan and
648,284 rows removed per loop.

### Projection and shape

- Projection `o.created_at::date AS day` retains expression SQL and resolves its
  underlying `orders.created_at`; projection `count(*) AS orders` records the
  non-distinct count aggregate.
- The group expression is the same `o.created_at::date`, not raw timestamp grain.
  Under the current contract `groupBy` can only carry the underlying `o.created_at`
  ref, so exact expression text must survive elsewhere or in an extension.
- `orderBy` is output alias `day ASC`; encode `column:null`, exact SQL, direction asc,
  with no binding error.
- No limit, offset, root distinct, subquery, or window.

The cast has two distinct roles: it is non-sargable in WHERE and semantically defines
the output/group's session-timezone-dependent day. Dropping either role is incomplete.

## q10 — grouped-key HAVING predicate that PostgreSQL pushes down

### Blocks and relation

- One root block with `o -> orders`; no joins, subqueries, or correlation.

### HAVING predicates

The AND expression must be decomposed into two predicates in `having` without
collapsing their different semantics:

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `count(*) > 5` | `having` / `range` | none (`count(*)`) | no | aggregate result exists only after grouping and cannot be a scan index condition |
| `o.customer_id < 1000` | `having` / `range` | `o -> orders.customer_id bigint` | yes | bare grouped key; PostgreSQL may legally push it below grouping and use the existing customer-id btree |

The second predicate may additionally appear in `o.localPredicates` because it is
pushable, but it must retain `clause='having'`; the first must not be localized. There
is no syntactic WHERE predicate.

### Projection and shape

- Projections: `o.customer_id`, `count(*) AS order_count`,
  `sum(o.total_cents) AS revenue`.
- `groupBy=[o.customer_id]`.
- Aggregates: non-distinct count and sum.
- No order, limit, offset, distinct, subquery, or window.

This is a calibration trap for the IR as well as downstream modules. The refreshed
plan shows `customer_id < 1000` as a bitmap index condition reading 9,990 rows, while
only `count(*) > 5` remains the aggregate filter. Labeling every HAVING predicate
non-sargable would erase the grouping-key distinction.

## q11 — correlated scalar max used in an outer equality

### Block graph and binding

- Two select blocks: root `main` over `o -> orders`, and one scalar-subquery block
  over the independently scoped `o2 -> orders`.
- The subquery has `correlated=true` and
  `correlationRefs=[o.customer_id]` bound to the enclosing `o`, not its local `o2`.
- The root is not correlated; there are no ordinary JoinIR records.

### Predicates

| Block / SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| root: `o.created_at = (<scalar subquery>)` | `where` / `subquery` | direct outer ref `o -> orders.created_at timestamptz` | no as a simple scan bound | the right value is a per-row correlated scalar computation; the subquery structure must not be reduced to a literal equality |
| subquery: `o2.customer_id = o.customer_id` | `where` / `join` | local `orders.customer_id bigint`; outer `orders.customer_id bigint` with distinct aliases | yes on `o2` | outer value acts as a parameter and the inner bare key can use the existing customer-id index |

### Projection and shape

- Root projects `o.customer_id`, `o.order_id`, `o.created_at`, and `o.total_cents`.
- Subquery projects aggregate `max(o2.created_at)` and records that non-distinct max.
- Root orders by resolved base ref `o.customer_id ASC`.
- No group, limit, offset, distinct, or window.

Retain equality-to-scalar-maximum rather than silently lowering it to “one row per
customer”: equality preserves all ties at the maximum timestamp. The plan confirms
the correlated subplan loops 2,000,000 times. Its actual outer result is 200,000 rows;
the collection index's 5,000 row count is a fetch/digest cap, not the plan cardinality.

## q12 — JSON extraction, IN list, distinct aggregate, and GROUP BY ordinal

### Blocks and relation

- One root block with `e -> events`; no joins, subqueries, or correlation.

### Predicates

| SQL | Clause/kind | Columns | Sargable | Reason |
|---|---|---|---|---|
| `e.payload->>'utm_source' = 'email'` | `where` / `equality` | underlying `e -> events.payload jsonb` | no for a raw-column btree | `->>` is an expression around the stored jsonb value; an exact expression btree could serve it, but a plain payload btree cannot |
| `e.occurred_at >= TIMESTAMPTZ '2024-06-01'` | `where` / `range` | `e -> events.occurred_at timestamptz` | yes | bare range with typed timestamp literal |
| `e.event_type IN ('add_to_cart', 'checkout')` | `where` / `in-list` | `e -> events.event_type text` | yes | finite list on bare column; summed MCV selectivity about 0.1002 |

All three are conjunctive and local to events. The extracted comparison's result type
is text even though its referenced storage column is jsonb; preserving the exact SQL
expression is therefore essential.

### Projection and shape

- Projection 1 is `e.payload->>'utm_source' AS source`, with underlying payload ref.
- Aggregates are `count(*) AS events` (`distinct=false`) and
  `count(DISTINCT e.customer_id) AS customers` (`distinct=true`, resolved nullable
  bigint argument).
- `GROUP BY 1` resolves to projection 1's JSON text extraction. It must not be treated
  as a literal constant or binding error. With the current `groupBy` type, carrying
  only `e.payload` loses the extraction; preserve the ordinal/expression in an
  extension or another stable field.
- `orderBy` is output alias `events DESC`, so `column:null` plus exact SQL.
- No limit, offset, root SELECT DISTINCT, subquery, or window.

The equality predicate fixes the grouping expression to one value, so the query has
one group in the refreshed plan. The IR must retain that the WHERE expression,
projection, and ordinal group key are the same expression; otherwise downstream
analysis cannot identify the redundant grouping key or choose a matching expression
index.

## Phase-2 comparison checklist (not yet executed)

When blindness is lifted, the highest-value structural checks are:

1. all 12 parse and bind with no spurious errors;
2. q03 and q11 have correct block count, alias scope, and outer correlation refs;
3. q05 remains `NOT IN` over a precisely bound nullable events column, not an anti
   join;
4. q06/q08 one-to-many edges are `fanOut=true`, while primary-key lookup edges are
   false;
5. q07 retains both LEFT join type and right-side WHERE placement;
6. q01/q09 expression predicates are false-sargable, q02 distinguishes infix from
   prefix with the live collation caveat, and q10's grouped-key HAVING range is true-
   sargable;
7. output aliases and q12's ordinal bind without errors, with exact expression SQL
   retained despite the contract's representation limits; and
8. limits, offset, distinct mode, aggregate-local distinct, group keys, and sort-key
   order all match the source SQL.

No source/output comparison, implementation inspection, score, or verdict belongs in
this Phase-1 document.
