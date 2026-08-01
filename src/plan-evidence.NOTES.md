# Saved plan evidence boundary

`plan-evidence.ts` is a read-only adapter for already-captured PostgreSQL
`EXPLAIN (FORMAT JSON)` output. It never connects to PostgreSQL or executes SQL.

Public API:

- `normalizePlanEvidence(input)` accepts PostgreSQL's one-element JSON array, a
  top-level `{ "Plan": ... }` document, JSON text, or a SQLSage evidence bundle
  with `planJson` and optional `sql` / `catalog`.
- `loadPlanEvidence(path)` reads JSON from disk and delegates to the same pure
  normalizer.
- `applyPlanEvidence(analysis, evidence)` returns a new `Analysis`, replaces
  offline execution predictions with captured scan/join/cost facts, and records
  only `verification.baselinePlan` plus `baselineMs` when the capture is
  analyzed.
- `PlanInputError` identifies invalid input without leaking parser stacks into
  the product boundary.

Evidence policy:

- `mode: "analyzed"` requires an `Execution Time` or at least one `Actual ...`
  node field. Otherwise the input is `mode: "plan-only"`.
- Plan-only cost units are never rendered as milliseconds. Applying a plan-only
  capture does not create `baselineMs`.
- The adapter never creates `optimizedPlan`, `optimizedMs`, or `resultsMatch`.
- PostgreSQL buffer counters are inclusive through the plan tree. Query-level
  temporary I/O therefore uses the maximum node counter instead of summing and
  double-counting ancestors.
- `Actual Rows` and `Plan Rows` are compared per loop, matching PostgreSQL's
  plan representation. `Actual Loops` remains separately visible.
- A single captured plan does not prove asymptotic scaling. The observed plan
  shape is combined with the existing offline scalability warning rather than
  promoted to a measured growth claim.

Deliberate limits for this milestone:

- The parser covers PostgreSQL JSON plans, not text plans or other databases.
- It summarizes physical operators and evidence; it does not attempt to rebuild
  SQL semantics from a plan.
- Worker-specific timing and buffer arrays remain in `document` but are not yet
  expanded into separate normalized worker records.
