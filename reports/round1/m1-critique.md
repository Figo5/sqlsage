# M1 Round 1 critique — schema-bound query IR

**Protocol:** Phase 1 was frozen before implementation/output inspection. This
document records Phases 2–4 against `reports/round1/m1-reference.md`.

## Executive judgment

M1 is unusually strong on the 12-query corpus. It imports cleanly under Node 24,
binds every corpus query with zero errors, passes its 268-assertion harness, and
gets all load-bearing corpus facts right: q03/q11 correlation, q05 nullable `NOT
IN` structure, q06/q08 fan-out, q07's exact outer-join demotion, q01/q02/q09
sargability, q10's grouped-key HAVING pushdown, q12's distinct aggregate, and all
orders/limits/offsets. The explanations attached to those facts are generally at
senior-engineer quality.

I am nevertheless not convinced. Fresh variants reveal several rules that only
appear to generalize. Most seriously, the exported q07 demotion analysis makes a
confidently false correctness claim for a null-tolerant `COALESCE` predicate and
misses a real demotion when an unrelated `IS NULL` appears inside an OR. Other
reasonable variants expose invalid `JOIN USING` binding, impossible cross-relation
`BitmapOr` advice, wrong fan-out on one-row derived cross joins, and quoted-name /
output-alias errors. Those are foundational facts downstream modules will trust.

## Phase 2 — corpus output against the blind reference

`node eval/dump-ir.ts --check` passes all 268 assertions. I also dumped every query
from the regenerated array-backed catalog and compared it field by field with the
frozen reference.

| Query | Result | Comparison |
|---|---|---|
| q01 | Match, with calibration caveat | One block; orders-to-customers join is non-fan-out; wrapped `date_trunc` is non-sargable with the PostgreSQL 16 TimeZone/STABLE caveat; status equality is sargable with MCV selectivity; grouping, aggregates, and output-alias order are correct. `o.estimatedRows=1,699,867` is only the status-filter estimate and silently ignores the unknown month predicate, so it looks more complete than it is. |
| q02 | Match | The OR remains one Boolean predicate. The reason independently classifies the leading-wildcard branch as non-btree-sargable and the prefix branch as conditional on C collation or `text_pattern_ops`; the live `en_US.utf8` probe validates that distinction. Projection, sort, and limit are correct. |
| q03 | Mostly match | Three blocks, two independently correlated subqueries, correct outer refs, scalar aggregate SQL, and output-alias order. The correlated equality is not attached to the inner orders relation's `localPredicates`, so each subquery relation is reported at about 2M rows even though the actual parameterized scans emit about 10 rows per outer loop. |
| q04 | Match | Correct two-relation inner join, non-fan-out PK lookup, status predicate, ordered `(created_at, order_id)` pair, `LIMIT 20`, and `OFFSET 100000`. |
| q05 | Match only in-process | The root `NOT IN` is a negated subquery predicate, the child is non-correlated, and its projected `events.customer_id` is correctly bound and nullable through `columnNullability()`. However, child linkage and nullability live only in WeakMaps and disappear after `JSON.stringify`/parse; the returned `QueryIR` alone does not carry the two facts that make q05 a correctness bug. |
| q06 | Match | Both one-to-many joins are `fanOut=true`, the PK sides are recognized, the multiplied `sum(o.total_cents)` and `count(*)` survive, and group/order/limit are exact. The 2.7x reason is honestly attributed to sampled `pg_stats`; live ground truth is exactly 3.0000x. |
| q07 | Match on the corpus text | The IR preserves `LEFT JOIN`, right-side WHERE placement, one-to-many fan-out, both local predicates, and `outerJoinDemotions()` finds the exact q07 defect. The generalized helper fails nearby predicates; see Finding 1. |
| q08 | Match | Fan-out vector `[true, true, false]`, local filters, customer-grain projection, and root `distinct=true` all match. |
| q09 | Semantics retained through a contract violation | The cast predicate is correctly non-sargable, source text and aggregate/order alias survive, and the group expression is preserved. But it is encoded as `{column:'o.created_at::date', unresolved:true}` even though `ResolvedColumnRef.unresolved` is documented as “binding failed”; the dump displays `o.o.created_at::date?`. A consumer obeying the shared contract can reasonably discard this valid group key. |
| q10 | Match | `count(*) > 5` remains post-group and non-sargable; `customer_id < 1000` remains syntactically HAVING but is also local/pushable and sargable. This agrees with the live bitmap index plan and avoids the deliberate folk-wisdom trap. Classifying the aggregate comparison as `other` rather than `range` is a minor loss of operator shape, not a wrong conclusion. |
| q11 | Mostly match | Two blocks, correct correlation ref, scalar max, outer subquery predicate, projections, and base-column order. As in q03, the inner parameterized equality is not a relation-local predicate. Refreshed ground truth now correctly records 200,000 output rows; the stale 5,000-cap sentence in the frozen Phase-1 reference is historical and was not used against M1. |
| q12 | Semantics retained through a contract violation | JSON extraction false-sargability, raw timestamp range, in-list selectivity, aggregate-local DISTINCT, output alias order, and ordinal-to-expression resolution are correct. As in q09, `GROUP BY 1` is represented by putting expression SQL in a `ResolvedColumnRef.column` and setting `unresolved=true`, so exact semantics exist only by contradicting the declared contract. |

All twelve have empty `windowFunctions`, no set operation, and the expected distinct,
aggregate, order, limit, and offset state. No corpus correctness bug in M1's scope is
missed.

## Phase 3 — adversarial variants and source audit

### Finding 1 — q07 null rejection is guessed by regex and is confidently wrong

`outerJoinDemotions()` in `src/ir/index.ts:1160` delegates null tolerance to
`isNullTolerant()` at lines 1193–1196. That helper recognizes only a top-level
null-check kind or the textual coexistence of `IS NULL` and `OR`; it does not evaluate
the predicate for a NULL-extended relation under SQL three-valued logic.

Two fresh variants fail in opposite directions:

```sql
-- Null-tolerant: unmatched customer rows pass.
WHERE coalesce(o.status, 'complete') = 'complete'

-- Null-rejecting in this schema because c.email is NOT NULL.
WHERE o.status = 'complete' OR c.email IS NULL
```

For the first, M1 emits a demotion with the categorical reason “A NULL-extended row
fails this test ... behaves exactly like an inner join.” PostgreSQL keeps the outer
join, and a two-row live VALUES proof returns `{2}` for LEFT JOIN versus no row for
INNER JOIN. The claim is factually false. For the second, M1 emits no demotion merely
because the SQL contains `OR ... IS NULL`; substituting nulls for `o` makes the filter
`NULL OR FALSE`, so unmatched rows are discarded and LEFT/INNER results are identical
in the same live proof. This is the biggest gap because it turns q07-class correctness
analysis into a syntax coincidence.

Fixed means retaining or deriving an expression tree and evaluating null rejection
per null-extended alias with PostgreSQL three-valued semantics. Unknown functions
should produce “unknown / needs verification,” not a categorical demotion.

### Finding 2 — `JOIN USING` has the join key but not PostgreSQL's merged namespace

M1 builds a correct synthetic equikey for `USING`, but `Scope.resolveLocal()` still
searches both base relations independently. PostgreSQL defines a USING key as one
merged output column and suppresses the redundant column from `SELECT *`.

The valid query below executes on the live server but M1 reports an ambiguity error
and returns an unresolved projection:

```sql
SELECT customer_id
FROM shop.customers c
JOIN shop.orders o USING (customer_id);
```

Likewise, `SELECT *` over that join should expose 14 columns (8 customers + 7 orders
minus one merged key); M1 exposes all 15 and duplicates `customer_id`. Qualified
`c.customer_id` and `o.customer_id` do work, proving this is specifically the missing
joined-table namespace rather than a parse failure. `NATURAL JOIN` would need the
same model if/when the parser accepts it.

### Finding 3 — OR sargability promises an impossible cross-relation BitmapOr

`assessDisjunction()` in `src/ir/predicates.ts:589–605` checks each leaf but never
checks that all leaves belong to one scan relation. For:

```sql
WHERE c.customer_id = 1 OR o.order_id = 1
```

M1 sets `sargable=true` and says PostgreSQL can combine the indexes with `BitmapOr`.
BitmapOr nodes combine bitmap scans for one heap relation; they cannot combine a
customers bitmap and an orders bitmap across a join. The live PostgreSQL 16 plan is a
parallel hash join with this expression as a `Join Filter` and a sequential scan of
orders, directly contradicting the reason. The estimated selectivity also applies an
independence formula across join inputs without any join-cardinality model.

Fixed means requiring every OR branch to target the same base relation before
claiming scan-level BitmapOr sargability. Cross-relation OR should remain a compound
join filter (or be explicitly “not scan-sargable / rewrite may be needed”).

### Finding 4 — CROSS JOIN is not unconditionally fan-out

`computeFanOut()` at `src/ir/index.ts:658–663` returns `fanOut=true` for every cross
join with the reason that it “multiplies unconditionally.” That is wrong when the
right input is provably at most one row. Two ordinary counterexamples are a scalar
aggregate and a `LIMIT 1` derived table:

```sql
CROSS JOIN (SELECT max(created_at) AS last_at FROM shop.orders) x
CROSS JOIN (SELECT order_id FROM shop.orders LIMIT 1) x
```

M1 labels both fan-out. Live plans estimate exactly one right row and 200,000 final
rows for 200,000 customers: neither can multiply a left row. Derived cardinality
proofs should include no-GROUP aggregate blocks, `LIMIT <= 1`, and single-row VALUES,
then let cross/no-equikey joins use that upper bound.

### Finding 5 — name binding accepts invalid quoted names and ambiguous aliases

Name comparison is unconditionally lowercased (`src/ir/scope.ts:97`,
`src/ir/index.ts:68`). Consequently M1 binds both `shop."ORDERS"` and
`o."ORDER_ID"` to lowercase catalog names with zero errors; PostgreSQL rejects both
because quoted identifiers are case-sensitive. This is the dangerous direction: the
IR confidently describes SQL that the target server cannot execute.

M1 also accepts:

```sql
SELECT o.order_id AS x, o.customer_id AS x
FROM shop.orders o
ORDER BY x;
```

It silently binds `x` to the first projection, whereas PostgreSQL reports `ORDER BY
"x" is ambiguous`. Output-name lookup must detect multiple matching aliases, and name
resolution must retain whether an identifier was quoted (using parser metadata or
the tracked source span).

### Finding 6 — critical semantics are hidden outside `QueryIR`

`nestedBlockIds` (`src/ir/index.ts:76–80`) and nullability use identity-keyed
WeakMaps. This is a clever in-process workaround, and `NOTES.md` acknowledges it, but
the advertised contract is still `bindQuery(...): QueryIR`. A JSON round-trip of q05
changes `nestedBlockIds(predicate)` from `['sub:1']` to `[]` and changes
`columnNullability(childRef)` from `{nullable:true,...}` to undefined. The serialized
predicate itself carries only the outer `customers.customer_id`, so it cannot recover
which child block or nullable projection makes the query wrong without reparsing.

The same contract pressure causes q09/q12 expression group keys to set
`unresolved=true` with a new undocumented meaning at `src/ir/index.ts:756–810`, in
direct conflict with `src/types.ts` (“True when binding failed”). Before downstream
modules are treated as independent, the shared contract should gain explicit
expression/group keys, child block ids, and nullability/derived-output metadata—or a
serializable companion object must become part of the official return type.

### Finding 7 — partial selectivity is presented as a complete row estimate

`estimateRelationRows()` multiplies every known local selectivity and silently ignores
unknown ones. q01 therefore reports approximately 1.70M orders after local predicates
although the real combined filter emits 48,437; q12 reports about 501K events while
the real conjunction emits 111,589. The notes correctly say selectivity is sparse,
but `RelationIR.estimatedRows` has no “partial upper bound” qualifier, so downstream
execution analysis can mistake these for calibrated post-filter estimates. If any
local conjunct is unknown, omit the number or attach confidence/bound provenance.

## Robustness that did survive fresh variants

There is no corpus special-casing in runtime code. Grepping `src/ir` found no query
ids, corpus literals, exact SQL fingerprints, or table-specific branches; q ids occur
only in `NOTES.md`, and corpus lookups occur only in the evaluation harness.

Fresh alias/shape changes also worked:

- q01 with reversed comparison operands, new aliases, and parentheses still marks
  `date_trunc` false-sargable and status true-sargable.
- q02 with reversed OR branches retains the mixed infix/prefix reason.
- q05 with new aliases and reversed inner equality retains NOT IN, child linkage,
  and nullable child metadata.
- q06 with new aliases and reversed join operands still returns fan-out
  `[true, true]`.
- q10 with reversed HAVING conjunct order still localizes only the grouped-key range.
- CTE grouped uniqueness, window bindings, nearest-scope ambiguity, FULL JOIN ON
  safety, integer/numeric promotion, and selective `NOT BETWEEN` BitmapOr behavior
  all pass the supplied edge checks. A live selective NOT BETWEEN plan confirmed the
  two bitmap scans; the broad harness example legitimately chooses a full scan/filter.

The implementation is therefore genuinely shape-driven, not a dressed-up answer key.
The problem is that several shapes are simplified beyond what PostgreSQL semantics
permit.

## Score

| Axis | Score | Rationale |
|---|---:|---|
| Correctness | 33/40 | All corpus facts survive the real plans, including all three correctness bugs in scope, but q07 variants, cross-relation OR, cross-join fan-out, USING, quoting, and duplicate aliases produce wrong facts or binding outcomes. |
| Completeness | 26/30 | Broad block/scope/join/predicate coverage and unusually good edge coverage; loses joined-table namespaces, serializable semantic links, derived at-most-one cardinality, and some expression structure. |
| Clarity | 19/20 | Source fragments and reasons are specific, readable, and evidence-oriented. The lost point is for categorical prose where the model has not actually established the claim. |
| Calibration | 8/10 | NOTES names most contract/parser limits and sparse selectivity honestly. Partial row estimates and several unconditional claims overstate certainty. |
| Subtotal | 86/100 | Before mandatory deductions. |

Mandatory deduction: **−25 confident and wrong**, applied for the q07 `COALESCE`
demotion claim. It explicitly says a NULL-extended row fails and the join becomes
inner; live SQL proves the opposite. The cross-relation BitmapOr and one-row CROSS
JOIN errors are additional examples reflected in the axis scores rather than stacked
as extra −25 penalties. No special-casing, folk-wisdom, or missed-corpus-correctness
deduction applies.

SCORE: 61
CONVINCED: no
BIGGEST_GAP: q07 variants in `src/ir/index.ts` need AST-based, relation-aware SQL three-valued null-rejection analysis; the current `isNullTolerant` regex returns both false demotions and missed demotions.
GAP_DETAIL: M1 claims `coalesce(o.status, 'complete')='complete'` demotes the LEFT JOIN, but a NULL-extended row satisfies that predicate and live PostgreSQL keeps the outer join; a VALUES proof returns an unmatched row for LEFT and none for INNER. Conversely, `o.status='complete' OR c.email IS NULL` is null-rejecting because `c.email` is NOT NULL, yet the regex suppresses the demotion merely because the text contains `OR` and `IS NULL`. Fixed means evaluating each WHERE expression under NULL substitution for the specific null-extended alias using PostgreSQL three-valued logic, returning unknown rather than a categorical claim when the expression cannot be proven.
