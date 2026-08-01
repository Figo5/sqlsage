# M5 — index recommender notes

`recommendIndexes(ir, catalog, findings)` is finding-gated and structural. It does not
inspect corpus ids, stored plans, ground truth, fingerprints, or exact full queries.
Definitions are derived from resolved predicates, join keys, ordering, projections,
catalog statistics, and M4's structured finding ids/evidence.

## Product policy

- Equality keys lead, followed by the first range or ordered cursor keys.
- Every ORDER BY/keyset column remains a key; `INCLUDE` is output/join payload only.
- Rewrite-coupled definitions say the current SQL receives no useful effect.
- q06 aggregate-grain correctness, q07 unresolved population intent, and q10's pushed
  grouping-key HAVING predicate deliberately receive no index.
- Expression B-trees are emitted only for the exact extracted scalar expression. Raw
  JSONB GIN is never claimed to serve `->>` equality.
- BRIN is selected only for a large table with absolute catalog correlation at least
  0.8; otherwise the raw range path falls back to B-tree.
- Partial indexes require fixed literal predicates; parameterized predicates are not
  assumed to imply a partial definition.
- Exact existing definitions are suppressed. Narrower existing indexes are listed as
  overlap, not automatically superseded.

Every storage estimate says unmeasured. Cost prose describes eligible entry count,
payload width, write/update maintenance, and the need for workload validation instead
of importing development-database sizes or timings into offline product output.

Stable advice ids are derived from the complete proposed definition through
`src/advice/definitions.ts`; PostgreSQL physical names are deterministically capped at
63 bytes. M6 calls the same M5 implementation over the same structural inputs so every
`requiresIndexes` value exactly names an emitted recommendation.

## Verification

```text
node --test src/indexes/index.test.ts
```

The suite covers all twelve recommendation decisions, DDL boundary recognition,
equality/range/key/include ordering, rewrite coupling, q06/q07/q10 no-index gates,
correlation-gated BRIN fallback, targeted JSON expression/partial advice, generalization
to another table/column combination, absent-finding behavior, and equivalent-index
suppression.

## Known limits

- This offline module has no plan or workload-frequency input, so expected effects are
  predicted/unverified and low-priority definitions remain optional.
- Catalog lacks extension, collation-per-expression, operator-class, index validity,
  and extended-statistics metadata. The MVP therefore declines speculative trigram
  advice and algebraic expression equivalence.
- Covering payload is capped and excludes wide JSON/bytea columns; it is not a complete
  workload-wide portfolio optimizer.
- Partial-predicate implication is supported only for fixed structural predicates the
  rewritten query carries verbatim.

