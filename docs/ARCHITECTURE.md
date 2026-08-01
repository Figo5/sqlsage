# Architecture

SQLSage is a deterministic pipeline over PostgreSQL SQL and metadata:

```text
SQL + Catalog
    -> bound query representation
    -> semantic explanation
    -> predicted or observed execution analysis
    -> correctness, intent, and performance findings
    -> index recommendations
    -> rewrites with explicit index dependencies
    -> text, Markdown, or JSON report
```

## Modules

- `src/ir/` parses and binds SQL to concrete relations and columns.
- `src/explain/` describes logical query behavior and result grain.
- `src/plan/` predicts execution from query structure and catalog statistics.
- `src/antipatterns/` emits structured correctness, intent, and performance findings.
- `src/indexes/` designs conservative PostgreSQL indexes.
- `src/rewrite/` produces bounded SQL rewrites with equivalence classifications.
- `src/report/` prioritizes and renders the complete analysis.
- `src/schema.ts` imports supported PostgreSQL DDL into the catalog model.
- `src/plan-evidence.ts` normalizes saved PostgreSQL JSON plans.
- `src/live.ts` enforces the connected-mode transaction and execution boundary.

The CLI is in `src/cli.ts`; `src/index.ts` is the package API. Release builds bundle
internal TypeScript into `dist/cli.js` and `dist/index.js`, leaving runtime dependencies
external so npm can install them normally.

## Evidence model

- Offline access paths and costs are predictions.
- A plan-only `EXPLAIN` establishes planner choices but not runtime.
- `EXPLAIN ANALYZE` establishes one measured baseline, not a promised improvement.
- Candidate rewrites, DDL, and speed effects remain unverified until separately tested.

## Safety invariants

- Only supported `SELECT` statements can reach live EXPLAIN.
- Live work occurs inside a timed, read-only transaction and rolls back in `finally`.
- Candidate rewrites and index DDL are output only.
- Result-changing rewrites are never described as equivalent.
- Missing or rejected analyzer data blocks a categorical clean verdict.
- JSON writes only to stdout; diagnostics write to stderr.
