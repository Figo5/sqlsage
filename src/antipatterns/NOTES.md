# M4 — anti-pattern detector notes

## Product role

`detectAntiPatterns(ir, catalog): Finding[]` turns M1's bound structural facts into
specific correctness, intent, and performance findings. It is intentionally not a
plan analyzer, index designer, or SQL rewriter:

- every finding points to the triggering SQL fragment and resolved relation/column;
- impact text uses only IR and catalog facts and labels row/cardinality values as
  estimates;
- no rule promises a speedup or presents catalog size as measured runtime;
- remediation is one scoped direction, with exact DDL and full SQL left to M5/M6;
- caveats state the nearby shape where the rule does not apply.

The implementation imports no corpus, query id, saved plan, ground-truth artifact,
fingerprint, or exact full SQL. Rules operate over `QueryIR`, `Catalog`, and M1's
public `nestedBlockIds()` / `outerJoinDemotions()` derived views.

## Rules implemented

| Finding | Structural proof | False-positive boundary |
|---|---|---|
| Nullable `NOT IN` | A negated subquery predicate is syntactically `NOT IN`, links to a one-column child block, and that output is proven nullable | `NOT EXISTS` and proven non-null subquery output are silent; unknown nullability is not promoted into a categorical finding |
| Aggregate over fan-out | A non-distinct, duplicate-sensitive aggregate projection reads an alias named in a join's `multipliedRelations` | Bare `fanOut` is never enough; lookup fan-out, item-grain measures, `count(*)`, and duplicate-insensitive MIN/MAX remain silent |
| Outer join demotion | M1's three-valued null-rejection analysis proves a WHERE predicate rejects every null-extension scenario | NULL-tolerant or unknown-function predicates are not guessed; the finding asks which population is intended and claims no slowdown |
| Wrapped/cast column | A WHERE equality/range applies a function or cast according to M1's sargability evidence, with no matching expression index in the catalog | JSON extraction has its own rule; a matching expression index suppresses the finding; scans can still be rational |
| Leading-wildcard search | LIKE/ILIKE has a literal beginning with an unescaped `%` or `_` | Anchored prefix patterns do not fire; OR receives a separate informational finding without claiming UNION is better |
| Repeated correlated aggregates | At least two correlated aggregate blocks read the same source for the same outer key and are used by separate parent expressions | One correlated projection is not automatically a problem; severity follows known outer cardinality |
| Deep OFFSET | Offset is at least 1,000 and at least ten requested pages | Shallow/random-access pagination stays silent; seek pagination is described as an API trade-off |
| DISTINCT over fan-out | DISTINCT projects an alias a join multiplies while at least one joined side contributes no projected column | A projected non-multiplied alias or output at the joined side's grain is not called an existence-only join |
| Correlated top-per-group | An equality predicate uses a correlated single MIN/MAX aggregate | Tie preservation is explicit; a projection-only extreme aggregate does not fire this rule |
| JSON scalar extraction | A JSONB `->>`/`#>>` predicate has no catalogued matching expression index | A raw JSONB GIN index is not claimed to serve `->>` equality; an exact expression path suppresses the finding |
| DISTINCT aggregate | A large catalog input feeds an aggregate marked `distinct` | This is observation-only: the metric may require DISTINCT, and no spill or runtime is asserted without a plan |

The PostgreSQL 16 grouping-key predicate in HAVING is deliberately not a rule. M1
already places such a predicate in the relation's pushable local predicates, so M4
does not repeat the folk claim that moving it to WHERE must improve performance.

## Severity and actionability

- `critical / correctness / required`: nullable `NOT IN` and a duplicate-sensitive
  aggregate proven to read a multiplied relation. These can change results.
- `high / intent / required`: a proven outer-join demotion. A decision is required,
  but SQL alone cannot choose the intended population.
- Performance severity is calibrated from structural work and catalog cardinality,
  never from the saved corpus timings. These findings are normally optional because
  the plan and workload decide whether a change pays off.
- Observation-only findings use `actionability: none` and explicitly prohibit a
  semantic change based on the observation alone.

Findings are deterministically ordered by severity, category, stable rule id, and
evidence fragment. Duplicate evidence is suppressed; repeated occurrences of the same
rule receive deterministic numeric suffixes so report components never share an id.

## Verification

Run:

```text
node --test src/antipatterns/index.test.ts
```

The focused suite covers:

- all 12 corpus queries, with a justified non-empty M4 assessment for q01–q09,
  q11, and q12, and a genuine empty result for q10;
- exact severity/category/actionability gates for q05, q06, and q07;
- reversed q06 FROM order plus lookup-, item-grain-, MIN/MAX counterexamples;
- `NOT EXISTS` and proven-non-null `NOT IN` counterexamples;
- NULL-tolerant outer joins, anchored LIKE, fully sargable OR, and shallow OFFSET;
- matching expression indexes versus a raw JSONB GIN index;
- selective repeated correlation versus full-cardinality top-per-group correlation;
- DISTINCT that does and does not hide an unprojected multiplied side;
- deterministic, complete Finding fields and behavior after QueryIR JSON round-trip.

## Deliberate limits

- M4 has no plan evidence. It cannot say that a scan, spill, loop count, runtime, or
  speedup was observed; M3 must augment those statements later.
- Nullable `NOT IN` proves the semantic hazard, not that a particular filtered
  subquery emits NULL today. A positive catalog-wide `nullFrac` raises confidence but
  does not model correlation with the subquery's other filters.
- Aggregate lineage comes from matching an aggregate with its projection columns.
  Duplicate-sensitive aggregates that appear only in HAVING, or lineage hidden behind
  a derived expression M1 cannot resolve, may be missed.
- Repeated-correlation grouping uses source relations and outer refs. In deeply nested
  queries with intentionally reused aliases, outer-cardinality calibration may fall
  back to unknown rather than inventing a count.
- Expression-index matching is conservative textual normalization over the expressions
  exposed by `Catalog`; PostgreSQL operator-class, collation, partial-predicate
  implication, and arbitrary algebraic equivalence require richer metadata/planner
  evidence.
- The shared IR has no typed Boolean predicate tree. Leading-wildcard branch extraction
  is therefore limited to literal LIKE/ILIKE syntax retained in the predicate fragment;
  parameterized patterns remain unknown rather than guessed.
- DISTINCT is only a Boolean in the current contract; DISTINCT ON keys cannot be
  distinguished and M1 already emits a binding warning for that loss.
