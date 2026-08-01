# M1 Round 2 critique — schema-bound query IR

**Protocol:** Re-review against the frozen `reports/round1/m1-reference.md` and
Round-1 critique. I inspected the current contract and every `src/ir/*` source file,
ran the complete corpus harness, reran all prior adversarial families and nearby
variants, checked serialization after JSON round trips, grepped runtime code for
corpus fingerprints, and used the live PostgreSQL 16.14 database for disputed name
resolution.

## Executive judgment

Round 2 is a substantial and genuine repair. The implementation imports under Node's
strip-only TypeScript support, all 12 corpus queries bind without errors, and
`node eval/dump-ir.ts --check` passes 337 assertions. Every Round-1 failure family is
fixed on both the original counterexample and useful adjacent cases: q07 analysis is
now relation-aware and conservative around unknown routines; ordinary `JOIN USING`
keys/chains/stars have merged-column behavior; OR no longer promises a cross-relation
`BitmapOr`; hard one-row proofs prevent false cross-join fan-out; quoted names and
duplicate output aliases are handled; semantic metadata survives JSON; and partial
selectivities are no longer presented as complete relation-row estimates. The corpus
contains no missed correctness bug, q10 still avoids the PostgreSQL-16 HAVING trap,
and runtime source remains shape-driven rather than corpus-special-cased.

I am not yet convinced because the new USING namespace has a confident wrong binding
on a nearby, ordinary table-expression shape. Once a merged USING key exists,
`Scope.resolveLocal()` returns it before considering same-named columns from other
FROM items. M1 therefore reports no error and binds an unqualified name that
PostgreSQL rejects as ambiguous. A second, smaller issue makes some parenthesized
Boolean-test predicate fragments malformed and forces the new null-rejection helper
to give up on a provable demotion.

## Round-1 regression matrix

| Round-1 gap | Round-2 result | Evidence |
|---|---|---|
| q07 regex-based null rejection | Fixed for the reported failures | `COALESCE(o.status, 'complete')='complete'` is tolerant; `o.status='complete' OR c.email IS NULL` is rejecting because `c.email` is NOT NULL; same-alias `OR ... IS NULL`, nullable preserved-side columns, CASE, known strict functions, unknown routines, FULL JOIN, and composite RIGHT JOIN scenarios are handled without a false categorical demotion. |
| `JOIN USING` key/star/chains | Fixed for a single joined-table namespace | An unqualified key resolves once, unqualified `*` has 14 columns and one key, qualified stars retain both keys, LEFT USING nullability follows the preserved side, and a three-table USING chain emits one merged key. A separate-FROM-item ambiguity remains; see Finding 1. |
| Cross-relation OR | Fixed | `c.customer_id=1 OR o.order_id=1` is non-sargable at scan level and has no invented selectivity; same-relation OR remains eligible for `BitmapOr`. |
| One-row CROSS JOIN | Fixed | Scalar aggregate, `LIMIT 1`, one-row VALUES, and no-FROM SELECT inputs are non-fan-out; two-row VALUES, grouped aggregates, and possible SELECT-list SRFs remain fan-out. |
| Quoted/duplicate names | Fixed for reported cases | Mixed-case quoted table/column names are rejected, exact quoted lowercase names and mixed-case aliases resolve, and duplicate ORDER BY/derived output aliases are ambiguous. |
| WeakMap-only semantics / overloaded group refs | Fixed | `subqueryBlockIds`, column nullability, and `groupByExpressions` are serializable fields; q05, q03, q09, q12, and q07 retain the relevant facts after JSON round trips, with no fake `unresolved` group expression. |
| Partial `estimatedRows` | Fixed | q01/q12 and correlated q03 scans omit the incomplete estimate; q04 retains its fully supported status estimate; correlated equality is attached as a parameterized local predicate. |

The original alias/order variants for q01, q02, q05, q06, and q10 continue to work.
All corpus block graphs, correlation, join direction/uniqueness, predicate placement,
projections, grouping, aggregates, sort keys, limits, offsets, and correctness facts
still match the frozen reference.

## Finding 1 — the merged USING key masks ambiguity outside its join

The early return at `src/ir/scope.ts:307-312` treats the existence of exactly one
entry in `mergedColumns` as a complete unqualified-name resolution. It does not ask
whether another output column in the same FROM scope has that name. This query is a
minimal counterexample:

```sql
SELECT customer_id
FROM shop.customers c
JOIN shop.orders o USING (customer_id),
     shop.events e;
```

M1 returns `bindingErrors=[]` and resolves the projection to
`c/customers.customer_id`. The live PostgreSQL 16.14 server instead returns
`ERROR: column reference "customer_id" is ambiguous`: the first joined table exposes
one merged `customer_id`, while `e` exposes a second. This is confident wrongness in
the binder's core contract, not a missing optimization hint.

The joined-table `starOutput` already has the correct shape: it contains each USING
key once and still contains unrelated relations' columns. Fixed means resolving an
unqualified name against that authoritative joined-output namespace (or otherwise
combining merged and non-member hits) and returning ambiguity whenever it has more
than one candidate. Add regressions for `(a JOIN b USING (k)), c`, multiple USING
keys plus an unrelated duplicate, and the corresponding qualified references and
stars.

## Finding 2 — parenthesized Boolean tests lose exact source and demotion proof

For this valid q07-shaped predicate:

```sql
WHERE (o.status = 'complete') IS FALSE
```

M1 stores `Predicate.sql` as `o.status = 'complete') IS FALSE`—the leading opening
parenthesis is missing while the closing one remains. `analyzeNullRejection()` then
cannot reparse it and returns `unknown`, so `outerJoinDemotions()` misses the real
demotion: on a null-extended row the inner equality is UNKNOWN and `UNKNOWN IS FALSE`
is false. The same malformed fragment occurs with `IS NOT TRUE` (which is genuinely
null-tolerant, so the conservative outcome happens to be safe there).

The failure is at the boundary between source recovery in `src/ir/text.ts:82-102`
and reparsing in `src/ir/null-rejection.ts:77-84`. Fixed means every stored predicate
fragment is syntactically balanced and source-faithful, plus direct tests for
parenthesized `IS TRUE`, `IS FALSE`, `IS NOT TRUE`, and nested NOT/CASE forms. Keeping
the original bound AST for semantic analysis would also avoid making correctness
proofs depend on a second parse of reconstructed text.

## Robustness and calibration

No runtime rule branches on a corpus id, title, exact corpus SQL, or fingerprint;
query ids occur only in notes/evaluation. The new 3VL evaluator is sensibly
conservative for unrecognized functions, and its known-function, COALESCE,
GREATEST/LEAST, NULLIF, CONCAT, CASE, AND/OR/NOT, and multi-relation substitution
paths survived the tested variants. `pgsql-ast-parser` still rejects some valid
PostgreSQL grammar such as `IS [NOT] DISTINCT FROM`; M1 records a parse error rather
than inventing an IR, and NOTES openly scopes the parser limitation, so I count that
as completeness rather than confident wrongness.

## Score

| Axis | Score | Rationale |
|---|---:|---|
| Correctness | 37/40 | Every corpus fact and all seven prior failure families are repaired, but the USING/comma case binds invalidly and Boolean-test source loss misses a provable demotion. |
| Completeness | 28/30 | Coverage is broad and the 337 checks are meaningful; joined-output ambiguity and several parser/source-expression edges remain. |
| Clarity | 19/20 | IR reasons and NOTES are specific, evidence-oriented, and calibrated; malformed `Predicate.sql` is the material exception. |
| Calibration | 9/10 | Unknown routine behavior and partial estimates now decline to overclaim. The clean binding of the ambiguous USING query is the remaining categorical overstatement. |
| Subtotal | 93/100 | Before mandatory deductions. |

Mandatory deduction: **−25 confident and wrong**. M1 returns an error-free, resolved
IR for the USING/comma query while the target PostgreSQL server rejects the same
column reference as ambiguous. No folk-wisdom, missed-corpus-correctness, or
special-casing deduction applies.

SCORE: 68
CONVINCED: no
BIGGEST_GAP: Fix unqualified `JOIN USING` resolution in `src/ir/scope.ts` so the merged key is compared with every other joined-output column and an unrelated same-named FROM column produces PostgreSQL's ambiguity error.
GAP_DETAIL: M1 correctly merges `c JOIN o USING (customer_id)`, but then accepts `SELECT customer_id FROM c JOIN o USING (customer_id), events e` and binds the name to `c`; live PostgreSQL 16.14 rejects it because the merged key and `e.customer_id` are two candidates. `resolveLocal()` currently returns the sole `mergedColumns` hit before examining the rest of the scope. Fixed means using the de-duplicated `starOutput` namespace for unqualified lookup, with one hit resolving and multiple hits reporting ambiguity, while qualified stars and chained USING behavior remain unchanged.
