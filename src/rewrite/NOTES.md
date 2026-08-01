# M6 — query rewriter notes

`proposeRewrites(ir, catalog, findings)` implements a deliberately narrow set of
executable PostgreSQL SELECT transformations. A rewrite exists only when M1/M4 prove
the complete supported shape; nearby shapes that would need assumptions return `[]`.
Production code imports no corpus, query id, stored plan, ground truth, or fingerprint.

## Supported transformations

- Month `date_trunc` and `timestamptz::date BETWEEN` filters become raw half-open
  timestamp ranges. Only valid, un-offset calendar literals are accepted; upper bounds
  are exclusive and q01 is inseparably coupled to its exact M5 definition id.
- Repeated correlated aggregate projections become one aggregate-only `LEFT JOIN
  LATERAL` only when source, correlation key, and every filter agree. This preserves
  COUNT=0/MAX=NULL on empty input without pre-grouping the entire inner table.
- Deep OFFSET becomes a same-direction, unique, complete row-value cursor using `$1…`
  parameters. Equivalence is conditional on the preceding-page cursor/snapshot and the
  notes state that arbitrary page jumps are lost.
- Nullable `NOT IN` becomes `NOT EXISTS`, explicitly `different-semantics` because it
  repairs NULL-poisoned results.
- Duplicate-sensitive aggregate fan-out reduces the final many-side to one row per join
  key, preserves joined-row COUNT via a summed row count, and labels corrected earlier-
  grain measures `different-semantics`.
- DISTINCT over an existence-only join becomes EXISTS only when projected columns prove
  a unique driver key, preventing accidental collapse of separate equal-looking rows.
- Correlated MIN/MAX becomes a grouped-extreme join that preserves every tie; it never
  substitutes DISTINCT ON or row_number().

q07 remains empty because SQL cannot choose outer versus inner population intent. q10
remains empty because the grouping-key predicate is already pushable. q02's OR and
q12's JSON/count-distinct observations do not receive speculative SQL changes.

## Verification

```text
node --test src/rewrite/index.test.ts
```

The suite binds every emitted corpus rewrite through M1, verifies exact q01 coupling,
half-open boundaries, one-pass LATERAL, row-value cursor shape and API caveat,
different-semantics correctness repairs, intent/false-positive empty gates, unique-key
proof for EXISTS, tie preservation, and generalized counterexamples with incompatible
filters/non-unique order/output.

## Known limits

- The SELECT renderer handles table-backed blocks with ordinary joins. Derived tables,
  set operations, DISTINCT ON, complex LATERAL trees, and aggregate FILTER clauses are
  declined rather than partially rewritten.
- Cursor SQL is parameterized; the caller must bind values of types compatible with the
  ORDER BY columns and manage snapshot/concurrency semantics.
- Fan-out repair currently supports a final one-key many-side with no projected/filter
  references beyond COUNT(*). More complex item measures require a purpose-built grain
  model rather than an automatic guess.
- No rewrite carries a measured speed ratio in offline mode. Expected effects remain
  predicted/unverified until plan evidence is integrated.
