# M1 Round 3 critique — schema-bound query IR

**Protocol.** Phase 1 was not re-executed: I adopted the frozen `reports/round1/m1-reference.md`
as my yardstick, as permitted, because it was written blind before any implementation existed.
Phase 2 compared current `bindQuery` output against it. Phase 3 read every file in `src/ir/`.
All disputed semantics were settled by asking PostgreSQL 16.14 directly, not by reasoning.
The database began and ended this review with exactly 8 indexes in `shop`; every index probe
ran inside `BEGIN; … ROLLBACK;`.

I treated the builder's `M1 checks passed: 373 assertions` as a claim, not evidence, and
re-derived every conclusion from my own probes.

---

## 1. Round-2 failures: both independently reproduced and both genuinely fixed

### 1.1 The merged `USING` key no longer masks ambiguity

Live server first:

```
$ docker exec sqlsage-pg psql -U postgres -d sage -c \
  "SELECT customer_id FROM shop.customers c JOIN shop.orders o USING (customer_id), shop.events e LIMIT 1;"
ERROR:  column reference "customer_id" is ambiguous
```

Current M1 on the same SQL:

```
errors: [error] column "customer_id" is ambiguous: more than one relation in scope exposes it
projections: "customer_id" :: [?.customer_id->UNBOUND UNRESOLVED]
```

Fixed. `Scope.resolveLocal()` (`src/ir/scope.ts:307-326`) now resolves unqualified names against
`starOutput`, PostgreSQL's real joined-output namespace, instead of short-circuiting on
`mergedColumns`. This is a principled namespace change, not a patch aimed at the reported string.

I probed the neighbourhood the brief listed. Every case matches the live server:

| Shape | PG 16.14 | M1 | |
|---|---|---|---|
| `c JOIN o USING (customer_id), e`, bare ref | ambiguous | ambiguous | ok |
| `c.customer_id` / `o.customer_id` / `e.customer_id` qualified | all three legal | all three resolve | ok |
| `c JOIN o USING (customer_id)` alone | legal | resolves to `c` | ok |
| 3-relation `USING` chain | legal, one merged key | no errors, one merged key | ok |
| 3-way chain **+** comma duplicate | ambiguous | ambiguous | ok |
| merged key + **CTE** exposing same name | ambiguous | ambiguous | ok |
| merged key + **subquery alias** exposing same name | ambiguous | ambiguous | ok |
| **parenthesized** joined table + comma | ambiguous | ambiguous | ok |
| merged key referenced in `WHERE` not `SELECT` | ambiguous | ambiguous | ok |
| genuine two-key `USING (order_id, customer_id)` | legal | resolves, `fanOut=false` via PK | ok |

Star expansion is exactly right. I materialised PostgreSQL's own output namespace and compared:

```
$ ... "CREATE TEMP VIEW v AS SELECT * FROM shop.customers c JOIN shop.orders o USING (customer_id);
       SELECT ordinal_position, column_name FROM information_schema.columns WHERE table_name='v' ..."
 1 customer_id | 2 email | 3 full_name | 4 country_code | 5 signup_date | 6 is_active
 7 loyalty_tier | 8 last_login_at | 9 order_id | 10 status | 11 created_at | 12 shipped_at
 13 total_cents | 14 coupon_code
```

M1's unqualified `*` emits those 14 in that exact order — merged key once, first, then remaining
left, then remaining right. `SELECT c.*` correctly returns 8 and still includes `customer_id`.

Merged-key nullability under outer joins is right for `LEFT` (`nullable=false`, preserved side is
`NOT NULL`) and `RIGHT` (binds to `o`, `nullable=false`). `FULL` is wrong but harmlessly — see
Finding 4.

### 1.2 Parenthesized Boolean source recovery

The Round-2 defect — `Predicate.sql` stored as `o.status = 'complete') IS FALSE` — is gone.
I ran 19 predicate shapes through a LEFT-JOIN frame and checked every stored fragment for
parenthesis balance. **All 19 balanced**, including `(((o.status = 'complete') IS FALSE)))`-style
nesting, `((o.status) = ('complete'))`, and `NOT (NOT (...))`. `recoverCrossingParentheses()`
(`src/ir/text.ts:124-147`) is a general balanced-pair repair over a real SQL tokeniser that skips
literals, line/block comments and dollar-quoting — not a special case.

More importantly the *semantics* are right, not merely self-consistent. I forced a genuinely
null-extended row on the live server and asked which predicates keep it:

```
$ ... "WITH slice(customer_id) AS (VALUES (1),(-1)) SELECT ... WHERE s.customer_id=-1 AND (<pred>)"
 baseline_unmatched | is_true | is_false | is_not_true | is_not_false | not_eq | case_eq | case_null | or_pred | coalesce_p | is_null_antijoin
                  1 |       0 |        0 |           1 |            1 |      0 |       0 |         1 |       0 |          1 |                1
```

| Predicate | PG keeps null-extended row? | PG verdict | M1 verdict |
|---|---|---|---|
| `(o.status='complete') IS TRUE` | no | rejecting | rejecting |
| `(o.status='complete') IS FALSE` | no | rejecting | rejecting |
| `(o.status='complete') IS NOT TRUE` | yes | tolerant | tolerant |
| `(o.status='complete') IS NOT FALSE` | yes | tolerant | tolerant |
| `NOT (o.status='complete')` | no | rejecting | rejecting |
| `CASE WHEN o.status='complete' THEN true ELSE false END` | no | rejecting | rejecting |
| `CASE WHEN o.status IS NULL THEN true ELSE false END` | yes | tolerant | tolerant |
| `o.status='complete' OR o.total_cents>0` | no | rejecting | rejecting |
| `COALESCE(o.status,'complete')='complete'` | yes | tolerant | tolerant |
| `o.order_id IS NULL` | yes | tolerant, **no demotion** | tolerant, no demotion |

Ten for ten. The `IS FALSE` demotion Round 2 said was missed is now found, and the anti-join
idiom is correctly *not* flagged.

**JSON round-trip.** I compared `outerJoinDemotions()` before and after
`JSON.parse(JSON.stringify(ir))` across all 19 shapes. Identical output, relation and full reason
string, in every case. The "balanced SQL fallback" after serialization does agree with the
identity-keyed AST path; I could not find the divergence the handoff warned about.

---

## 2. Finding 1 (headline) — fan-out is orientation-dependent, so q06's correctness signal disappears on a reordered rewrite

This is the highest-value defect and neither prior round tested for it.

q06's whole reason for existing is that `sum(o.total_cents)` triple-counts revenue after the
`order_items` join, and the brief states plainly that `fanOut` "is what lets a downstream module
catch q06's silent 3.0000x revenue over-count." M1 gets q06 right **as written**. It gets the
identical query wrong when the FROM items are listed in the other order — an entirely ordinary way
to write it.

Live proof that it is the same bug:

```
$ docker exec sqlsage-pg psql -U postgres -d sage -c "..."
         form         |  revenue
----------------------+-----------
 q06 as written       | 366766560
 q06 joins reversed   | 366766560
 TRUTH (no item join) | 122255520
```

Exactly 3.0000x over-count, identical in both orderings. Now M1 on the reversed form:

```sql
SELECT c.customer_id, sum(o.total_cents) AS revenue_cents
FROM shop.order_items oi
JOIN shop.orders o    ON oi.order_id = o.order_id
JOIN shop.customers c ON o.customer_id = c.customer_id
GROUP BY c.customer_id
```
```
inner oi -> o fanOut=false
   reason=orders.(order_id) is the primary key and is covered by the join key,
          so at most one row matches per key value, so this join cannot multiply rows.
inner o -> c fanOut=false
   reason=customers.(customer_id) is the primary key and is covered by the join key,
          so at most one row matches per key value, so this join cannot multiply rows.
```

Every join reports `fanOut=false` and the prose says "cannot multiply rows" — about a query that
triples revenue. I grepped the entire serialized IR for any compensating signal: the only two
occurrences of "multipl" are those two *negative* claims. No `duplicat`, no `grain`, no
`over-count`. `RelationIR.estimatedRows` carries raw table sizes (5,999,977 / 2,000,000 / 200,000)
but no conclusion. A downstream module keying on `fanOut` finds nothing to report and will ship
the over-count silently. The same happens to q08's DISTINCT-hides-fan-out shape reversed
(`fan=false,false`).

Each individual verdict is defensible under `JoinIR.fanOut`'s wording, and the Round-1 reference
does bless left-to-right orientation. But that same reference attaches a proviso: *"An equivalent
orientation is acceptable only if its uniqueness reasoning carries the same information."* Here it
demonstrably does not.

**Root cause.** `computeFanOut()` (`src/ir/index.ts:698-752`) tests only the **right** input's
uniqueness; when `proveUnique(right, …)` succeeds it returns at line 744-746 without ever asking
about the left. The other direction is already computed — `leftUniquenessNote()`
(`src/ir/index.ts:773-782`) does exactly that arithmetic — but it is consulted *only* inside the
`fanOut=true` branch (line 750). In the reversed q06, join 1 has `oi` on the left, and
`order_items.order_id` is non-unique (pg_stats `n_distinct=-0.37087935`, ~2.7 rows per key), so
`o`'s columns — including `total_cents` — are duplicated before `sum`. M1 already has that number.
It just never asks the question in this branch.

**Fixed looks like:** when the right side is provably unique, `computeFanOut` still tests the left
input's uniqueness on the key; if the left input is not unique, record that the *right* relation's
rows are multiplied, so an aggregate over a right-side column is over-counted. Judge multiplicity
against the joined input's grain, not one base relation's. The verdict must be stable under
reordering the FROM items of q06.

---

## 3. Finding 2 (confident and wrong) — `USING` is rejected when a preceding comma relation shares the key name

The mirror image of the Round-2 counterexample. PostgreSQL's grammar binds `JOIN` tighter than
`,`, so in `FROM e, c JOIN o USING (customer_id)` the `USING` left side is **only** `c`. The
server accepts it:

```
$ docker exec sqlsage-pg psql -U postgres -d sage -c \
  "SELECT c.customer_id, o.order_id FROM shop.events e, shop.customers c JOIN shop.orders o USING (customer_id) LIMIT 1;"
 customer_id | order_id
-------------+----------
           1 |   200000

$ ... EXPLAIN SELECT c.customer_id FROM (SELECT 1) e, shop.customers c JOIN shop.orders o USING (customer_id) LIMIT 1;
 Limit
   ->  Nested Loop
         ->  Seq Scan on customers c
         ->  Index Only Scan using idx_orders_customer_id on orders o
               Index Cond: (customer_id = c.customer_id)
```

M1 on the same SQL:

```
errors: [error] USING (customer_id) does not resolve on both sides of the join
        [error] USING (customer_id) cannot form a merged output column: the key is ambiguous on one side
joins:  inner c -> o fanOut=true
        reason=there is no equality join key, so nothing bounds how many right rows
               a left row can match; every left row can be multiplied.
        keys=            <-- equi-key dropped entirely
```

Three wrong things: two `severity:'error'` binding errors on SQL PostgreSQL executes; the equi-key
silently dropped from `JoinIR.equiKeys`; and an unhedged claim that "there is no equality join key"
that the plan contradicts with `Index Cond: (customer_id = c.customer_id)`. A reader would conclude
their valid query is malformed and that the join is an unbounded multiplier.

**Root cause.** `src/ir/index.ts:361`:

```ts
const previous = entries.slice(0, i).map((e) => e.rel).filter(Boolean) as BoundRelation[];
```

`previous` is the flattened FROM prefix, so comma-joined items are handed to
`Scope.usingLeftColumn()` as if they were part of the join's left operand. That helper then sees
two candidates (`e.customer_id` and `c.customer_id`) and returns `'ambiguous'`.

Scope of the failure, characterised:

| Shape | M1 |
|---|---|
| `p, c JOIN o USING (customer_id)` — `p` lacks the key | correct, no errors |
| `e, c JOIN o USING (customer_id)` — `e` has the key | **2 spurious errors, key dropped** |
| `e, p, c JOIN o USING (customer_id)` | **2 spurious errors, key dropped** |
| same shape written with `ON` instead of `USING` | correct, no errors |

So it fires only when a comma-preceding relation shares the key name, and only for `USING`.
**Fixed looks like:** `previous` for a join must be that join's left operand subtree, not every
earlier FROM entry — `,` is looser than `JOIN`.

---

## 4. Finding 3 (minor, wrong sub-claim) — chained same-key joins misstate left-input uniqueness

For `c JOIN o USING (customer_id) JOIN e USING (customer_id)`, M1's second-join reason ends:

> The left input is unique on the key (customers primary key (customer_id)), so right-side rows are
> not duplicated in the other direction.

The left input of that join is `c ⋈ o`, not `c`:

```
$ ... "SELECT count(*), count(DISTINCT customer_id) FROM shop.customers c JOIN shop.orders o USING (customer_id) WHERE customer_id < 50;"
 left_input_rows | distinct_keys
             490 |            49
```

Not unique — each `e` row *is* duplicated ~10x. The `fanOut=true` verdict is right; the trailing
sentence is false. Same root cause family as Finding 1: `leftUniquenessNote()` inspects one base
relation instead of the joined input. q06 and q08 are unaffected because their chains use
*different* keys, and I verified the surviving uniqueness there (490 rows / 490 distinct
`order_id`).

## 5. Finding 4 (minor) — `FULL JOIN … USING` merged key marked nullable when it provably is not

M1 reports the merged key of `c FULL JOIN o USING (customer_id)` as `nullable=true`
(`mergedNullability`, `src/ir/scope.ts:381-384`). The merged column is `COALESCE(l, r)`, and every
FULL-join output row has at least one side present, so with both base columns `NOT NULL` it cannot
be null:

```
$ ... "SELECT count(*) FROM (SELECT customer_id FROM shop.customers c FULL JOIN shop.orders o USING (customer_id)) t WHERE customer_id IS NULL;"
 0
```

Conservative in the safe direction; low impact. Worth noting that M1's *sargability* verdict for
`WHERE customer_id = 5` over that FULL join is **correct** — I expected an over-claim and the plan
proved me wrong, pushing the condition to both sides as `Index Cond: (customer_id = 5)`.

## 6. Finding 5 (cosmetic) — `LIKE 'Cust%mer'` reason misdescribes the pattern

Verdict correct (sargable on prefix `Cust`, confirmed below); the generated reason says the pattern
"has a trailing wildcard only", which is false for a mid-pattern wildcard.

---

## 7. Fundamentals — re-checked, and largely excellent

**Sargability against the live planner.** I built `full_name text_pattern_ops` inside a transaction,
forced `enable_seqscan=off`, and rolled back:

```
=== LIKE 'Customer 1%' ===  Index Cond: ((full_name ~>=~ 'Customer 1') AND (full_name ~<~ 'Customer 2'))
=== LIKE 'Cust%mer'    ===  Index Cond: ((full_name ~>=~ 'Cust')       AND (full_name ~<~ 'Cusu'))
=== ILIKE 'Customer 1%'===  Seq Scan
=== LIKE '%Customer%'  ===  Seq Scan
```

M1 matches all four. **It does not over-flag the trailing-wildcard `LIKE`** — q02's
`full_name LIKE 'Customer 1%'` is `like-prefix`, `sargable=true`, with the `text_pattern_ops` /
non-C-collation caveat carried in the reason rather than used as a disqualification. That is the
correct call and the brief's explicit trap. Across a 22-case battery I found no false positive and
no false negative: `ILIKE`, leading `_`, infix and suffix patterns are non-sargable; escaped
`'100\%%'` correctly yields prefix `100%`; `<>`, function/cast/arithmetic-wrapped columns and
column-to-column comparisons are non-sargable; `IS NULL`/`IS NOT NULL` are sargable *with* the
pg_stats null-fraction attached and opposite advice for each direction.

**q10 — the folk-wisdom trap is avoided.** M1 marks `count(*) > 5` non-sargable (aggregate) and
`o.customer_id < 1000` **sargable**, with a btree index-condition reason. The real plan agrees:

```
 HashAggregate ... Filter: (count(*) > 5)
   ->  Bitmap Heap Scan on orders o ... rows=9990
         ->  Bitmap Index Scan on idx_orders_customer_id
               Index Cond: (customer_id < 1000)
```

No speedup is promised anywhere. No −15 folk-wisdom deduction.

**q07.** `JoinIR.type='left'` preserved, both WHERE predicates retain `clause='where'`, and the
demotion is derived with a correct 3VL argument. It survives alias renaming, clause reordering,
extra parentheses and a mirrored `RIGHT JOIN`. The `IS NULL` anti-join idiom and a predicate
correctly placed in `ON` both produce **no** demotion.

**fanOut on the corpus.** q06 `c->o` true and `o->oi` true; q08 `c->o` true, `o->oi` true,
`oi->p` **false** (products PK); q01/q04 false (customers PK). Correct in the as-written forms.
A pre-aggregated CTE (`GROUP BY order_id`) is correctly `fanOut=false` via `uniqueOutputKeys` — a
real derived-uniqueness proof, not a table lookup.

**Correlation.** q03 has two distinct subquery blocks, each `correlated=true` with
`correlationRefs=[c.customer_id]`; q11 has one with `[o.customer_id]` bound to the enclosing `o`,
not local `o2`. `NOT EXISTS` variants correlate correctly too.

**Binding errors.** Zero across all 12 corpus queries, including q01/q03/q06/q09/q12 output
aliases in `ORDER BY` and q12's `GROUP BY 1` (resolved with `ordinal=1` and the underlying
`payload` column). Unknown columns, unknown tables, unknown qualifiers, ambiguous unqualified
names and outright garbage are all *recorded*, never thrown.

**q12 selectivity** is `0.100200001` from summed MCVs — matching the blind reference's independent
"about 0.1002" prediction exactly.

**Calibration note on fan-out magnitude.** M1 reports the `order_items` fan-out as "about 2.7x",
sourced explicitly to pg_stats (`n_distinct=-0.37087935`). Live truth is exactly 3.0000x. The
attribution is honest, so this is not a wrong claim, but a downstream module quoting "2.7x" will
understate the revenue over-count by ~10%.

**Parser limits** (`NATURAL JOIN`, `IS UNKNOWN`, `IS NOT UNKNOWN`, `IS DISTINCT FROM`) are
`pgsql-ast-parser` gaps. M1 records a parse error and invents no IR. Honest, and scoped in
`src/ir/NOTES.md` — completeness gaps, not confident wrongness.

---

## 8. Phase 3 — source inspection

**No corpus special-casing.** Grepping `src/ir/` for query ids, corpus titles and corpus-specific
literals (`'complete'`, `'gold'`, `'checkout'`, `Customer 1`, `@example.com`, `utm_source`,
`loyalty_tier`, `order_items`, …) returns nothing in runtime code; ids appear only in `NOTES.md`
prose. No fingerprint, hash, `sql ===`, `sql.includes`, or query-shape lookup table exists. Every
`new Set([...])` is a principled SQL-semantics table (strict builtins, comparison/arith operators,
aggregate and window-only function names, stable casts, texty/integer type families). The
`resolveLocal` and `recoverCrossingParentheses` fixes are both genuine generalisations — I verified
each against variants the last critic never named, and they held everywhere except the two
neighbourhoods in Findings 1 and 2.

**Fake generality.** Found in exactly one place: the Round-2 `USING` fix generalises across CTEs,
subqueries, parentheses and chains, but not across FROM-item *order* (Finding 2). And the fan-out
rule generalises across aliases, CTEs and pre-aggregation, but not across join orientation
(Finding 1).

---

## 9. Score

| Axis | Score | Rationale |
|---|---:|---|
| Correctness | 34/40 | The 12 corpus queries are flawless and every live-checkable verdict — 10/10 three-valued-logic outcomes, 4/4 `LIKE` plans, q10's pushdown, star-expansion order — matches PostgreSQL 16.14. Deducted for the `USING`/comma rejection of valid SQL with a plan-contradicted fan-out claim, the false left-uniqueness sentence in same-key chains, and the FULL-join merged nullability. |
| Completeness | 24/30 | Every item on the reference's Phase-2 checklist passes. But the multiplicity signal — the module's single most load-bearing output — vanishes when q06's joins are reordered, and parser gaps remain. |
| Clarity | 18/20 | Reasons are specific, evidence-bearing and well-sourced: pg_stats numbers with attribution, collation caveats, STABLE-vs-IMMUTABLE notes on `date_trunc`/`timestamptz::date`, GIN-containment guidance for jsonb. Two reason strings contain false sub-claims. |
| Calibration | 9/10 | Strong discipline: declines on unrecognised functions, omits partial row estimates, records parser limits honestly, and states no speedup on q10. Loses a point for two unhedged `severity:'error'` claims on valid SQL. |
| **Subtotal** | **85/100** | Before mandatory deductions. |

Mandatory deduction: **−25, confident and wrong** (Finding 2). M1 emits two hard binding errors and
asserts "there is no equality join key" for a join the live planner executes as
`Index Cond: (customer_id = c.customer_id)`.

No folk-wisdom deduction — q10 is handled correctly. No missed-corpus-correctness deduction — q05,
q06 and q07 all carry their signals in the as-written corpus forms. No special-casing deduction.

**85 − 25 = 60.**

A note on comparability: this is not evidence of regression against Round 2's 68. Both Round-2
defects are genuinely and broadly fixed, and I verified them far more widely than Round 2 did. The
lower number reflects a structural gap (Finding 1) that neither prior round tested for, plus a new
confident-wrong neighbour of the old one.

SCORE: 60
CONVINCED: no
BIGGEST_GAP: Make `fanOut` multiplicity orientation-independent in `computeFanOut()` (`src/ir/index.ts:698-752`) so that reordering q06's FROM items does not erase the 3x revenue over-count signal.
GAP_DETAIL: `computeFanOut` returns `fanOut=false` as soon as `proveUnique(right, …)` succeeds, never asking whether the *left* input is unique on the key. Writing q06 as `order_items oi JOIN orders o ON oi.order_id=o.order_id JOIN customers c ON o.customer_id=c.customer_id` therefore yields `fanOut=false` on both joins with the reason "so this join cannot multiply rows", while the live server returns the identical wrong revenue (366,766,560 against a true 122,255,520 — exactly 3.0000x); I grepped the serialized IR and no other field carries the signal. The arithmetic already exists in `leftUniquenessNote()` (`src/ir/index.ts:773-782`) but is only consulted inside the `fanOut=true` branch and only against a single base relation, not the joined input. Fixed means testing left-input uniqueness in the unique-right branch too, recording that the right relation's rows (and therefore any aggregate over its columns) are multiplied, and judging grain against the joined input so the verdict is stable under FROM reordering — with regression tests for reversed q06/q08 and for the same-key `USING` chain whose left input is no longer unique.
