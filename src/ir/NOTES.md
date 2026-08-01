# M1 — schema-bound query IR notes

## Approach

`bindQuery(sql, catalog)` parses with location tracking, creates one lexical
`Scope` per query block, and resolves references from the innermost block
outward. It preserves separate blocks for CTEs, derived tables, scalar/EXISTS
subqueries, and set operations; an enclosing-scope hit marks the child block as
correlated and records the concrete outer references.

The binder treats catalog facts as proofs, not hints. Join fan-out is false only
when a primary key, total unique index, or grouped/deduplicated derived output
proves right-side uniqueness on the complete equi-key. Hard derived-cardinality
bounds also prove that scalar aggregates, `LIMIT <= 1`, one-row `VALUES`, and
scalar SELECTs cannot fan out a cross/no-key join. Possible SELECT-list SRFs
deliberately suppress the scalar-SELECT proof. Otherwise fan-out is true and,
for a single catalog key, the reason includes the `pg_stats` rows-per-key
estimate. A foreign key, ordinary index, or planner row estimate never
masquerades as uniqueness.

`JOIN USING` is modelled as a joined-table namespace rather than as equality
syntax alone: unqualified key lookup resolves to one merged column, unqualified
`SELECT *` emits the key once in PostgreSQL's output order, and qualified stars
retain each input key. Identifier comparison uses the parser's PostgreSQL
folding: unquoted names arrive lower-case, while quoted mixed-case spelling is
matched exactly. Duplicate select-list aliases and duplicate derived output
names are reported when a lookup makes them ambiguous.

Predicates retain their author-written source fragments, bound columns, clause,
shape, selectivity when the fixture supports one, and a reasoned sargability
verdict. The implementation distinguishes bare-column seeks from functions,
casts, jsonb extraction, leading/trailing wildcard patterns, row-dependent
operands, subplans, and integer-to-numeric promotion. Time-zone-sensitive
casts/functions are called out where PostgreSQL would reject the expression as
non-IMMUTABLE. Prefix `LIKE` is described as conditional on C collation or a
`text_pattern_ops` index; infix `LIKE` is not called btree-sargable.

For facts that are analyses rather than stored syntax, M1 also exports derived
views:

- `nestedBlockIds(predicateOrProjection)` links a subquery-bearing expression to
  its child blocks.
- `columnNullability(ref)` exposes catalog/outer-join nullability.
- `analyzeNullRejection(predicate, relation)` reparses the preserved predicate
  fragment and abstractly evaluates PostgreSQL TRUE/FALSE/UNKNOWN after
  substituting NULL for one relation. It returns `rejecting`, `tolerant`, or an
  honest `unknown`; unknown function NULL policies are never guessed.
- `outerJoinDemotions(ir)` derives WHERE predicates that discard null-extended
  rows, but only from a proven `rejecting` result.

Nullability, child block ids, and lossless group expressions/ordinals are now
ordinary serializable `QueryIR` fields. The compatibility helpers read those
fields first, so their results survive a JSON round-trip; WeakMaps remain only
as compatibility caches for older in-process consumers.

## Validation performed

`node eval/dump-ir.ts --check` currently runs 337 assertions over all 12 corpus
queries plus synthetic and adversarial edge cases. It checks all-corpus binding,
source fragments, q06/q08 fan-out, q01/q02/q09 sargability, q05 NOT IN structure and
nullable child output, q07 demotion, q10 HAVING pushdown, correlation,
group/order alias precedence, window bindings, CTE uniqueness, FULL JOIN ON
pushdown safety, ambiguity shadowing, implicit numeric casts, and NOT BETWEEN's
two-range shape. Round-2 regressions cover null-tolerant `COALESCE`, null-rejecting
cross-relation OR, same-alias null tolerance, strict and unknown functions,
three-valued CASE/AND, same- versus cross-relation BitmapOr, USING binding/star
shape, one-/two-row derived cross joins, possible SRFs, exact quoted names,
duplicate output aliases, JSON round-trips, complete-only row estimates, and
parameterized correlated local predicates. Every corpus query binds with zero
errors. The direct Node 24 import also passes, and `src/ir` contains no parameter
properties, enums, or namespaces.

## Deliberate limits

- **Derived-expression lineage is the weakest area.** A CTE/subquery output is
  name- and type-bound, and grouped output uniqueness is propagated, but the IR
  cannot say that `d.x` came from a particular base expression. A predicate on
  a derived output is therefore conservatively not called sargable; it may in
  fact be pushed into the producing block. Computed-output nullability is left
  unknown rather than inherited incorrectly (`max(non_null_col)` can still be
  NULL on empty input).
- Null rejection is AST/three-valued rather than textual, but routine/operator
  metadata is not in `Catalog`. Common PostgreSQL strict built-ins and special
  non-strict forms (`COALESCE`, `NULLIF`, `GREATEST`/`LEAST`, `concat`) are
  modelled; an unrecognized function widens to `unknown`, which can cause a
  missed demotion but cannot cause a false categorical one. Predicates whose
  fragments cannot be reparsed are likewise `unknown`.
- The contract has no predicate tree. An OR remains one boolean predicate. Its
  reason evaluates every branch (including the `text_pattern_ops` caveat), but
  downstream code cannot traverse typed child predicates without reparsing.
  Scan-level BitmapOr is promised only when every branch targets the same one
  relation.
- Selectivity is intentionally sparse: equality/IN use MCVs or `n_distinct`,
  null checks use `null_frac`, and OR uses an explicit independence assumption.
  No histogram or extended-statistics data exists in the fixture, so ranges,
  correlations, and multi-column estimates are left unknown. A relation's
  `estimatedRows` is omitted when any local conjunct has unknown selectivity;
  M1 does not present a partial product as a complete post-filter estimate.
- Sargability is shape-based, not a promise that the planner will choose an
  index. It recognizes only a narrow set of certain implicit-cast hazards and
  common PostgreSQL function-volatility cases. Unknown casts/functions are not
  declared safe or unsafe as expression indexes.
- Aggregate recognition covers PostgreSQL's built-ins plus aggregate-only
  syntax. A plain call to an unknown user-defined aggregate is indistinguishable
  from a scalar function without routine metadata.
- `NATURAL JOIN` depends on parser support and is not synthesized independently;
  `JOIN USING` is covered. `DISTINCT ON` is represented only by the shared
  boolean `distinct` field; M1
  emits a warning because the key list has nowhere lossless to live.
- SELECT is the deeply validated path. INSERT/UPDATE/DELETE receive basic target
  and WHERE blocks, but assignments, RETURNING, UPDATE FROM/DELETE USING, and
  write-specific semantics are not fully modelled. `pgsql-ast-parser` also
  constrains the PostgreSQL grammar M1 can accept.
- Source recovery preserves tokens and restores omitted subquery/list
  delimiters, then collapses incidental whitespace for report readability. It
  is not a byte-for-byte formatting archive.

No rule branches on a corpus id, title, fingerprint, table-specific SQL string,
or exact query text.

---

## Round 4 — fan-out made orientation-independent

**What was wrong.** `computeFanOut()` returned `fanOut=false` the moment the *right*
side proved unique on the join key, and never asked whether the *left* input was
unique. The verdict therefore depended on how the author ordered their FROM clause.
Round 3 rejected M1 at 60 for this, and it reproduces cleanly:

```
q06 as customers→orders→order_items :  fanOut=true  on both joins
q06 as order_items→orders→customers :  fanOut=false on both joins,
                                       reason "so this join cannot multiply rows"
```

Both spellings return the identical wrong revenue on the live server — 902,913,180
against a true 300,971,060, exactly 3.0000x. So the correctness signal five downstream
modules consume vanished depending on spelling, and the reason string asserted the
opposite of the truth.

**What changed.** `fanOut` now means *"this join multiplies the rows of **either**
input"*. Two fields were added to `JoinIR` (additive and optional, so nothing
downstream breaks):

- `fanOutSide: 'left' | 'right' | 'both' | 'none'`
- `multipliedRelations: string[]` — the aliases whose rows this join duplicates

`multipliedRelations` is the field that actually matters downstream: an aggregate over
any relation named there is over-counted. When the left *input* is multiplied, every
relation joined so far is listed, because the whole joined product is duplicated — that
is what makes the signal survive reordering without needing a separate propagation pass.

`proveLeftUnique()` judges the left **input**, not one base table: uniqueness must be
provable from the catalog *and* the relation must not already appear in
`multipliedAliases` from an earlier join. Multiplicity is cumulative.

**Verified.** All three orderings of q06 now report `multiplied={c,o}`, so
`sum(o.total_cents)` is flagged in every spelling. The same query without
`order_items` reports `multiplied={c}` and does **not** flag `sum(o.*)` — the rule
stays silent where it should. 20 new assertions cover the three orderings, the
mirror-image case, a genuinely unique-on-both-sides join, and a `USING` chain whose
left input stops being unique after the first step. 393 assertions pass.

**One existing assertion was changed, deliberately.** q08's third join
(`order_items → products`) was asserted `fanOut=false`. That encoded the old
orientation-dependent meaning and was factually wrong: `products.product_id` is a
primary key so no order_item row is duplicated, but the left input is not unique on
`product_id`, so each *product* row repeats. Confirmed on the live server — that join
emits 19,935 rows over 250 distinct products, ~79.7x per product row. The assertion now
expects `true` with `side='right'` and records the measurement in a comment.

### Known limits of this change

- `fanOut=true` is now **noisier** by design: a plain lookup join onto a primary key
  reports `true` with `side='right'` whenever the left input is not unique on the key
  (q01's `orders → customers` is such a case). That is semantically correct — those
  right-side rows genuinely repeat — but a downstream module must read
  `multipliedRelations` and check whether an aggregate actually touches a named
  relation. **Treating bare `fanOut` as "something is wrong here" will produce false
  positives.** M2 and M4 should key off `multipliedRelations` ∩ aggregate sources.
- `proveLeftUnique` is conservative: anything it cannot prove from the catalog is
  reported not-unique, which costs a noisier verdict rather than a missed correctness
  signal. That trade is deliberate but it does mean derived tables without a provable
  unique output key will over-report.
- Multiplicity is tracked per binder instance across a block's joins in FROM order. A
  join whose left relation is not among `previous` (unusual shapes, some LATERAL forms)
  falls back to "not provable", i.e. noisier rather than silent.

## 2026-08-01 — correlated LATERAL fan-out

A correlated `LATERAL` spells its join condition *inside its own block*, so the outer
`ON` reads `ON true` and only **looks** keyless. The keyless branch of `computeFanOut`
therefore claimed both sides were multiplied, which over-reported the lateral's own
rows: an aggregate over them is exact whenever the outer side is unique on the
correlation key.

`lateralCorrelation()` recovers the keys. It looks inside the derived block for an
equality between one of that block's relations and a relation written to its **left**.
Only a lateral can produce one — a plain derived table is bound against the enclosing
scope and cannot see those aliases at all, so a *resolved* reference to one of them is
itself the proof of correlation. This is structural; nothing sniffs for the `LATERAL`
keyword.

The verdict then mirrors the equivalent plain join:

| lateral rows per outer row | outer unique on key | side | multiplied |
|---|---|---|---|
| ≤ 1 | yes | `none` | — |
| ≤ 1 | no | `right` | the lateral alias |
| many | yes | `left` | the left input |
| many | no | `both` | both |

"At most one row per outer row" is proven only in the simple shape — one base relation,
no joins of its own, correlated on columns that relation is unique over. Anything richer
is left as "can return many": noisier, never silent.

**Verified against the live server, not reasoned about**:
`node reports/round4/probe-lateral.ts` sums the lateral's own column over the join and
compares it to the true sum. Case A is exact; cases B and C inflate by exactly 10.0000x,
and the IR's `multipliedRelations` agrees with the server in all three. Case D holds the
line on an uncorrelated lateral, and a negated correlation is not accepted as a key.

**Limits.** A correlation through an expression (`o.customer_id = c.customer_id + 0`), a
correlation reaching two levels out, or a lateral whose inner block joins several
relations all fall back to the pessimistic keyless verdict. Those are noisier, not
wrong, and are the obvious places for a critic to push.
