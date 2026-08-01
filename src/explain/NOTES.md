# M2 semantic explanation

`explainSemantics()` turns the root `QueryBlockIR` into a logical narrative. It follows
the conceptual order—sources and joins, row conditions, correlated values, grouping,
post-group conditions, duplicate removal, ordering, and row windows—and derives the
result grain and output meanings from projections and grouping keys.

The implementation treats M1 facts as proofs. Nullable `NOT IN` output, outer-join
demotion, and relation-specific `multipliedRelations` are consumed directly. In
particular, an aggregate warning fires only when an aggregate's source alias intersects
the aliases that M1 says were multiplied; bare `fanOut` is intentionally insufficient.
This prevents a normal many-to-one lookup from being mislabeled as an over-count.

The module contains no access-path or tuning advice. It does use small, shape-oriented
checks inside already-bound SQL fragments where the shared contract is not lossless—for
example, distinguishing `count(DISTINCT ...)`, recognizing an inclusive `BETWEEN`, and
describing a correlated `max` equality as tie-preserving. These checks are independent
of table names and query identity.

## Deliberate limits

- `QueryIR` does not preserve a typed expression tree or `DISTINCT ON` key list.
  Expression prose is therefore strongest for common aggregates, casts, JSON text
  extraction, and subqueries, and intentionally generic for arbitrary functions.
- The explanation can prove that a nullable subquery *can* poison `NOT IN`; without
  conditional data statistics it does not claim that a qualifying NULL exists now.
- A multiplied aggregate is described as data-dependent. The catalog can often suggest
  an average multiplier, but semantics should not turn an estimate into a promised
  wrong-result factor.
- Grain for complex set operations, row-producing functions, and nested derived-output
  lineage is conservative because the shared IR does not expose all of that lineage.
- Session time-zone sensitivity is identified for the common timestamp-with-time-zone
  conversions represented by M1. It does not infer the business's intended time zone.

