# M3 offline execution prediction

`predictExecution()` predicts PostgreSQL execution from `QueryIR` and `Catalog` only.
It does not load captured plans or timings. Access paths use leading-key compatibility,
covering columns, ordering, relation size, and driver selectivity. Join choices combine
equality keys, available lookup paths, uniqueness/FK facts, and conservative size
thresholds. Every reason starts from an offline prediction and names credible
alternatives when missing histograms leave a crossover unresolved.

Correlated blocks are linked back to their parent through the stable subquery IDs. Their
work is expressed as driver rows multiplied by average inner rows per key, so two scalar
subqueries remain two pieces of repeated work and a per-row correlated self-lookup is
recognized as `sum(k^2)` scaling. Nullable `NOT IN` is called a likely hashed membership
SubPlan, explicitly not an anti-join. Grouping-key conditions in HAVING remain local,
sargable relation predicates because M1 proves that distinction, allowing PostgreSQL 16
pushdown to be predicted without pretending the wording forces a full aggregation.

Dominant-cost ranking uses structural work units only—rows read, repeated loops, join
fan-out, grouping, duplicate removal, ordering, and OFFSET depth. It intentionally emits
no milliseconds, buffers, worker counts, or claimed speedups. Memory entries are framed
as pressure to verify rather than claims of a current spill.

## Deliberate limits

- This is a heuristic offline predictor, not a replacement for PostgreSQL's cost model.
  Histogram bounds, extended/expression statistics, visibility-map coverage, cache
  state, most cost settings, and physical tuple overhead are absent from the contract.
- Complex join reordering is not exhaustively enumerated. The module predicts each
  structural join and names uncertainty rather than fabricating one total physical tree.
- Index-only predictions mean all referenced columns are present. They remain conditional
  on visibility-map coverage, which the catalog does not expose.
- Partial and expression indexes are not declared usable without a proof that their
  expression/predicate matches. The current implementation therefore prefers a false
  negative over a false positive for those forms.
- Hash and sort memory arithmetic is deliberately coarse. It identifies plausible
  pressure but never reports a current batch count, temporary write, or spill without
  observed evidence.
- Conditional NULL rates, LIKE/JSON/date ranges, cross-table duplicate density, and
  correlated extreme-value ties remain explicit estimation risks.

