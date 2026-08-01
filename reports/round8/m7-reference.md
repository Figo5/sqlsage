# M7 blind reference — report rendering and prioritization

## Blind-phase declaration

This is the Phase 1 yardstick for M7. It was written before reading any file under
`src/report/`, before running or reading `eval/dump-report.ts`, and before seeing any
renderer output. It is therefore a specification of the report a senior PostgreSQL
performance engineer should want, not a reaction to the implementation.

Evidence reviewed:

- the shared `Analysis` contract in `src/types.ts`;
- all twelve corpus queries, the schema, live catalog statistics, and the final
  median-of-three ground-truth plans;
- the q01 paired verification experiment and the q05/q06 result checks recorded in
  `HANDOFF.md` and `reports/round1/harness-validation.md`;
- PostgreSQL 16 documentation and expert material listed under Sources below.

No comparison, source audit, score, or verdict belongs in this phase.

## M7's job and its boundary

M7 should turn one `Analysis` into a decision document. Within roughly one screen, a
reader should be able to answer:

1. What does the query return, at what grain?
2. Is it semantically safe, or is there a wrong-result/intent blocker?
3. What is the highest-value next action?
4. What evidence is measured, what is predicted, and what remains unverified?
5. Which rewrite and index must be deployed together?

M7 is not a second analyzer. It must not invent a cause, a speedup, an index benefit,
or result equivalence that is absent from `Analysis`. It also must not silently repair
bad upstream advice. Its responsibility is to preserve every material upstream fact,
give each fact the right prominence, and expose its epistemic status so weak upstream
claims do not acquire false authority through polished prose.

There is a contract limitation worth making explicit. `Finding` has severity and
confidence but no `category` or `affectsCorrectness` field. A generic M7 therefore
cannot reliably discover correctness findings by matching words in titles or IDs;
doing so would be brittle and invite corpus special-casing. The safe convention is
that upstream modules encode definite wrong-result defects as `critical` and semantic
intent blockers as at least `high`, and M7 gives those severities precedence. A later
cross-module contract revision should add an explicit risk category, but the Round 1
renderer should not fake one with text heuristics.

## Ideal report information hierarchy

The report should follow this order. Empty sections may collapse, but the state they
represent must never disappear.

### 1. Identity and executive verdict

- Identify SQLSage, the catalog name, and the statement type.
- Lead with `semantics.headline`, followed by the result grain in plain language.
- Show exactly one calibrated status line, chosen from states such as:
  `CORRECTNESS BLOCKER`, `INTENT MUST BE CONFIRMED`, `PERFORMANCE ACTION`,
  `NEEDS VERIFICATION`, or `NO PERFORMANCE ACTION REQUIRED`.
- State the first action in one sentence. Do not begin by echoing the full SQL,
  enumerating every section, or reporting a low-value count such as “3 suggestions.”
- If binding has errors, the first status is instead `ANALYSIS PARTIAL`; identify the
  unresolved fragment and say that downstream recommendations are provisional.

The executive verdict must not call every rewrite an “optimization.” A
readability-only change such as q10 is optional cleanup. A semantics-correcting
rewrite such as q05 is a correctness repair. An unmeasured candidate is a proposal.

### 2. Correctness and intent blockers

- Render every `critical` finding before runtime, indexes, or style suggestions.
- Include the affected expression and the user-visible consequence, not merely the
  SQL anti-pattern name.
- Show the exact evidence fragment, confidence, and any assumption or caveat.
- When correctness depends on business intent, present the alternatives rather than
  pretending intent is known.
- A failed result-equivalence check for an `exact` or satisfied `conditional` rewrite
  is itself a stop-ship blocker. Do not celebrate a speedup beneath it.

### 3. Recommended change set

- Present actions in deployable bundles, not in separate “rewrites” and “indexes”
  silos when `Rewrite.requiresIndexes` couples them.
- Within a bundle: show the intended outcome, rewritten SQL, required DDL, why the key
  order matters, expected plan change, equivalence status, assumptions, confidence,
  operational cost, and how to verify it.
- Priority `1` precedes `2`, which precedes `3`. Within a priority, a correctness
  repair precedes performance; then higher severity/confidence; ties retain input
  order for deterministic output.
- A required index must appear adjacent to the rewrite that unlocks it. It may also
  appear in a later index detail section, but the primary presentation cannot make the
  two look independently useful.
- `IndexRecommendation` has no stable ID even though `Rewrite.requiresIndexes` stores
  strings. Resolve only by an explicit, documented convention (for example exact DDL
  identity). If a dependency cannot be resolved, print the unresolved reference and
  mark the action incomplete; do not guess from similar column names.
- Never hide lower-priority actions, but place optional cleanup after the main plan.

### 4. Verification snapshot

Use visibly different labels for these categories:

- **Observed:** facts supplied by actual plans or measured timings.
- **Verified change:** both variants were tested and the relevant result condition
  was checked.
- **Predicted:** `ExecutionAnalysis`, `expectedEffect`, and `expectedSpeedup` claims
  without a live paired test.
- **Unknown/not checked:** absent verification fields.

Rules for `Analysis.verification`:

- With positive finite `baselineMs` and `optimizedMs`, show `baseline -> optimized`,
  the absolute delta, and `baseline / optimized` as the speedup. Label it measured.
- Do not compute a ratio from zero, negative, `NaN`, or infinite values. Show the raw
  valid fields and mark the comparison unavailable.
- `resultsMatch: true` means the tested result sets matched on that dataset. It is not
  proof of logical equivalence for all inputs, so show rewrite `equivalence` and
  `equivalenceNotes` separately.
- `resultsMatch: false` rejects an `exact` rewrite and ordinarily rejects a
  `conditional` rewrite whose assumptions hold. For `different-semantics`, it can be
  expected (q05); state that the changed result still requires validation against the
  intended business meaning or an independent oracle.
- If only baseline timing exists, say “optimized variant not measured.” If only result
  matching exists, say “performance not measured.” If plans are absent, say so.
- If verification is entirely absent, print one concise line: “Not run; plan changes,
  speedups, and result equivalence are unverified.” Never silently omit the section.
- Unknown plan objects must never render as `[object Object]`. Either extract a small,
  defensible plan delta or serialize a bounded, readable detail block. Do not claim a
  node changed unless both supplied plans support that claim.

### 5. Why it behaves this way

- Render `execution.dominantCosts` before the full access-path inventory.
- Keep predicted access paths explicitly labeled as predictions unless a live plan is
  attached.
- Attach numbers to claims where available: actual rows, loops, rows removed, buffers,
  elapsed time, sort/hash spill behavior, and estimate error. Cost units are not
  milliseconds.
- When quoting per-loop plan values, multiply by `loops` or make the per-loop nature
  explicit. A reader must not mistake q11's ten rows per subplan execution for ten
  rows total.
- Show memory and estimation risks only when supplied; do not manufacture a spill from
  a large in-memory hash. End with scalability so a fast-today-but-dangerous query
  such as q03 is calibrated correctly.

### 6. What the query does

- Include the logical steps and result shape from `SemanticExplanation` in readable
  prose.
- Keep semantic caveats prominent; if one is correctness-relevant it should already
  have been surfaced near the top and may be cross-referenced here.
- Preserve SQL fragments needed to connect prose to the query.
- Put the original SQL after the executive/action material, not before it. Preserve
  whitespace and never truncate executable rewrite SQL or DDL without an explicit
  marker and a way to obtain the full text.

### 7. Assumptions, costs, and optional detail

- Collect conditional equivalence assumptions, finding caveats, timezone/collation
  dependencies, and index write/storage costs under an unmistakable heading.
- “Exact,” “conditional,” and “different semantics” must be human-readable labels, not
  raw enum values without explanation.
- Confidence belongs beside the claim it qualifies, not in an unexplained footer.
- A high-confidence prediction remains a prediction. A low-confidence critical risk
  remains visible and should trigger investigation, not be sorted below cosmetic work.

## Required corpus anchors

These anchors judge ordering and calibration, not M7's ability to rediscover facts
that upstream modules omitted. Given a correct `Analysis`, the report must surface the
following story.

| Query | What the report must lead with | Evidence and calibrated action |
|---|---|---|
| q01 | **The rewrite and index are one change set.** `date_trunc` on `created_at` prevents the proposed ordinary btree from serving the predicate. | The refreshed baseline is about 112 ms and scans all 2M orders; the plan reports 650,521 rows removed per worker. In the controlled paired check, the index alone remained a sequential scan and was 1.04x slower, while a half-open range plus `(status, created_at) INCLUDE (customer_id, total_cents)` produced an index-only scan, identical tested results, and a 3.94x speedup. Show rewrite and DDL together; never claim the index alone helps. State the timezone/boundary assumption. |
| q02 | **Current latency is modest, but the search shape does a full scan and will scale poorly.** | About 22 ms on 200k customers; the leading-wildcard email predicate and cross-column `OR` feed a parallel sequential scan and top-N sort. Present trigram/prefix-index and possible `UNION` choices with collation and duplicate-semantics caveats. Do not manufacture urgency from the presence of a sequential scan. |
| q03 | **Two correlated subplans duplicate work, but the current selective outer set keeps this run fast.** | About 31 ms for 2,000 gold customers. Each subplan loops 2,000 times; current indexes keep each probe small, while the plan still touches 34,440 shared buffers. Frame a grouped/LATERAL rewrite as a scaling improvement, preserve zero-order customers, and do not call this the slowest query. |
| q04 | **Deep OFFSET performs and discards work proportional to page depth.** | About 393 ms; the plan produces 100,020 ordered rows to return 20 and uses roughly 20 MB for each worker's top-N sort. Lead with keyset pagination plus the matching `(created_at, order_id)` order, and state the product tradeoff: no arbitrary page jump. |
| q05 | **Correctness blocker: the query returns zero rows because the nullable subquery contains NULL.** | The schema marks `events.customer_id` nullable; the plan hashes 100k checkout customer IDs and filters all 200k customers. The checked `NOT EXISTS` form returns 196,000 customers. Present this as a semantics repair before the roughly 149 ms runtime. Result mismatch with the buggy query is expected, not proof the repair failed; intended meaning still must be confirmed. |
| q06 | **Correctness blocker: revenue is over-reported by exactly 3.0000x on this data.** | The item join expands 1.7M complete orders into 5.1M rows before aggregation; the measured total is 1,280,102,100,000 instead of 426,700,700,000. The roughly 2.4 s runtime is secondary. Recommend aggregating at the correct grain/removing the unnecessary fan-out; explicitly reject `sum(DISTINCT o.total_cents)` as a generally unsafe repair. |
| q07 | **Intent blocker: as written, no customer without a complete order can survive.** | The right-side `WHERE o.status = 'complete'` null-rejects the outer rows; the actual plan has an ordinary nested loop, not an outer join, and returns 149,000 rows in about 88 ms. Offer two branches: move the predicate into `ON` to retain unmatched customers, or write `INNER JOIN` if matched customers were intended. This is not a promised speedup. |
| q08 | **`DISTINCT` is repairing join fan-out after the work has happened.** | Roughly 19,935 rows reach worker-level deduplication to produce 3,000 customers, after scanning all 6M order items; median is about 296 ms. Present an `EXISTS`/semi-join rewrite and supporting access paths, while keeping equivalence and duplicate semantics explicit. |
| q09 | **The predicate casts the indexed-side timestamp and forces a full orders scan.** | About 81 ms; 2M rows are scanned and roughly 648k are removed per worker. Recommend a raw-column half-open range ending July 1; keep the cast in grouping if desired. State timezone semantics and do not suggest a mutable `timestamptz::date` expression index. |
| q10 | **No performance action required.** Moving the grouping-key predicate to `WHERE` is optional readability cleanup. | PostgreSQL 16 already pushes `customer_id < 1000` to `idx_orders_customer_id`: bitmap index/heap scan, 9,990 input rows, 999 output groups, about 6.9 ms. `count(*) > 5` correctly remains in `HAVING`. Do not call the rewrite faster, do not propose a new index, and do not inflate an optional cleanup into the headline. |
| q11 | **The correlated aggregate runs once for every outer order and dominates the corpus.** | About 6.58 s; the subplan loops 2M times, reads 26M shared buffers, and the outer filter rejects 1.8M rows. A `DISTINCT ON` or window rewrite needs explicit tie semantics; PostgreSQL 16 does not have btree skip scan. The report must not label a tie-breaking rewrite “exact” unless the assumption is supplied. |
| q12 | **A selective-looking JSON expression still causes a full 5M-event scan.** | About 196 ms and over 80k shared buffers; 111,589 rows enter the distinct/group work and one constant-key group comes out. Present an expression/composite index as a proposal, note the redundant constant `GROUP BY`, and keep `count(DISTINCT customer_id)` and exact expression/type matching visible. Do not imply a GIN index is automatically best for a single extracted-text equality. |

## Correctness presentation acceptance tests

### q05 — NULL-poisoned `NOT IN`

Acceptable headline:

> BLOCKER — This query currently returns no customers. A NULL checkout customer ID
> makes `NOT IN` evaluate to unknown for every candidate; use `NOT EXISTS` after
> confirming “customers with no checkout” is the intended result.

Unacceptable behavior:

- leading with the sequential scan or 149 ms runtime;
- saying only that `NOT EXISTS` is “usually faster”;
- labeling the repair exact-equivalent to the buggy output;
- treating `resultsMatch: false` as an optimization failure without considering
  `equivalence: different-semantics`.

### q06 — fan-out corrupts the aggregate

Acceptable headline:

> BLOCKER — Joining orders to items changes the aggregation grain and triples reported
> revenue on this dataset. Restore one row per order before summing; then tune runtime.

The report should name `sum(o.total_cents)`, the input-grain change, and the measured
3.0000x result error. “The join produces more rows” is not enough. Runtime, hash memory,
and the top-N sort follow after the wrong-answer warning.

### q07 — outer join intent is unknowable

Acceptable headline:

> INTENT REQUIRED — The `WHERE` predicate removes NULL-extended order rows, so the
> query behaves as an inner join. Keep the predicate in `ON` to retain unmatched
> customers, or write `INNER JOIN` if excluding them is intended.

Do not state unconditionally that moving the predicate is the one correct rewrite.
The query's intended behavior is external information. Also do not promise a plan
speedup: PostgreSQL already demotes the join.

## q01 dependency acceptance test

The change set should read as one ordered unit:

1. Rewrite the month equality to an explicit half-open range on raw `created_at`.
2. Create/use the `(status, created_at)` btree with required payload columns if the
   supplied recommendation calls for covering behavior.
3. State the timezone used to interpret month boundaries.
4. Validate result equivalence and compare plans/timings on representative parameters.

The report fails this test if it places the index under “quick wins,” separates the
rewrite many screens away, or describes either as independently yielding the measured
3.94x speedup. The paired evidence specifically shows the index alone did not change
the plan.

## q10 no-action acceptance test

A correct input may still contain an info-level rewrite for clarity. M7 should render
that under “Optional cleanup” and retain “No performance action required” as the main
status. An action counter should not call it “1 optimization,” and an expected-speedup
field that says approximately zero or same plan must not be dropped. The observed
bitmap index condition is evidence that generic HAVING advice does not apply here.

## Confidence, evidence, and assumptions

Every displayed finding should preserve this tuple:

`severity + confidence + exact SQL evidence + impact here + remediation + caveat`

Every index should preserve:

`priority + confidence + exact DDL + serves + expected plan effect + key-order reason +
write/storage cost + redundancy`

Every rewrite should preserve:

`priority + full SQL + rationale + equivalence class + equivalence notes + expected
speedup status + required indexes`

Rendering only title/severity loses the evidence that makes the advice actionable.
Conversely, repeating every field without hierarchy creates a data dump. The compact
view should show the decisive fields, with complete SQL/DDL and caveats directly below.

Language calibration:

- “Measured” only for supplied live measurements.
- “Verified” only when the claimed dimension was checked; timing does not verify
  results, and result matching does not verify speed.
- “Expected” or “predicted” for analyzer hypotheses.
- “Exact under these assumptions” is contradictory; use `conditional` and list them.
- “No action required” is positive expert output, not an empty state.
- Avoid “will,” “guarantees,” and precise speedup numbers for untested changes.

## Empty, partial, and malformed analysis behavior

M7 must be useful under degraded inputs and must not overclaim:

- `findings: []` => “No findings were supplied/identified,” not “This query has no
  problems.”
- `indexes: []` => “No index recommendation supplied,” not “No index is needed.”
- `rewrites: []` => “No rewrite supplied,” not “The query is already optimal.”
- All three empty => still render the semantic headline, grain, any execution analysis,
  and a clear `ANALYSIS INCOMPLETE OR NO ACTION IDENTIFIED` state.
- Binding warnings/errors => list them before advice; errors make downstream analysis
  provisional. Never bury `QueryIR.bindingErrors` in debug detail.
- Missing verification => the explicit unverified sentence defined above.
- Partially populated verification => show field-level unknowns; do not infer missing
  values.
- Missing optional estimates (`estimatedRows`, `estimatedShare`, complexity, index
  size) => omit the number and preserve the qualitative reason. Do not print `undefined`,
  `null`, `NaN`, or fake zeroes.
- Unexpected runtime omissions in required nested objects => render the available
  sections plus a visible “partial analysis” warning instead of throwing. TypeScript
  types do not protect JSON/API callers at runtime.
- Empty SQL strings should be marked unavailable. SQL/DDL containing terminal control
  characters must have unsafe controls escaped so analysis text cannot inject ANSI
  sequences or rewrite the terminal.
- Rendering must not mutate or reorder arrays on the caller's `Analysis` object.

These states should be covered by deterministic fixtures: full analysis, semantics
only, empty arrays, binding error, baseline-only verification, timing-only verification,
result mismatch for exact and different-semantics rewrites, invalid numeric timing,
unresolved index dependency, and strings containing terminal escape characters.

## Terminal and plain-mode consistency

Terminal and plain output must be two presentations of the same report model.

- Same executive verdict, section order, actions, SQL/DDL, evidence, confidence,
  assumptions, verification state, and warnings in both modes.
- Terminal mode may add ANSI color, emphasis, symbols, and width-aware wrapping. Color
  is never the sole carrier of severity or verification state.
- Plain mode contains no ANSI/control escapes and remains readable when redirected to
  a file, CI log, issue, or pager.
- Stripping ANSI and normalizing decorative borders/wrapping from terminal output
  should yield the same semantic lines as plain output. Terminal mode must not omit
  caveats to save space, and plain mode must not be a debug dump.
- Long SQL and DDL remain copyable. Wrapping must not insert characters into executable
  text; if a display wraps visually, the underlying string is unchanged.
- Output is deterministic for the same `Analysis` and options. Ties preserve input
  order. No current time, random IDs, environment-dependent colors, or object key-order
  accidents should make snapshot output drift.
- User-controlled SQL, aliases, catalog names, and prose are sanitized before terminal
  styling. Existing ANSI bytes in input must not be trusted.

At minimum, tests should compare plain output with ANSI-stripped terminal output for a
full critical report, a q01-style coupled action, a q10-style no-action report, and an
empty/partial report.

## Anti-patterns in the report itself

The following are automatic senior-quality failures even if the prose looks polished:

- correctness findings appear below indexes or runtime tuning;
- predicted execution is phrased as observed;
- every rewrite is advertised as a speedup;
- action counts equate readability changes with verified optimizations;
- q01's rewrite and index are shown as independent wins;
- q10 receives a performance headline or unnecessary index;
- `resultsMatch: true` is called proof of universal equivalence;
- `resultsMatch: false` is always called failure, even for an intentional correctness
  repair;
- caveats, conditional equivalence notes, index write cost, or low confidence vanish;
- empty arrays are translated into “optimal” or “safe”;
- ANSI color is the only distinction between critical and informational text;
- implementation branches on corpus IDs, exact SQL, or suspicious phrase matching to
  produce these outcomes.

## Sources and reasoning extracted

- [PostgreSQL 16: Using EXPLAIN](https://www.postgresql.org/docs/16/using-explain.html):
  actual time/rows are per-loop averages, cost units are not time, buffers identify I/O,
  filter/join placement affects semantics, and `EXPLAIN ANALYZE` measurements have
  execution and instrumentation caveats. A report must therefore attach units and
  provenance rather than quote plan numbers decoratively.
- [pganalyze: Comparing EXPLAIN plans](https://pganalyze.com/blog/understanding-how-to-compare-postgres-explain-plans):
  a useful comparison highlights structural plan differences and buffers rather than
  placing two opaque trees side by side.
- [pganalyze: Query Tuning Workbooks](https://pganalyze.com/blog/introducing-postgres-query-tuning-workbooks):
  the expert workflow is measure, form a hypothesis, change one or more things, compare
  plans, and validate outcomes across relevant parameters. M7 should expose which step
  has actually happened.
- The module-specific sources in `docs/EXPERT-SOURCES.md` supply the technical caveats
  M7 must preserve: nullable `NOT IN`, half-open ranges, multicolumn key order,
  `DISTINCT ON` tie behavior, PostgreSQL 16's lack of btree skip scan, and the product
  constraint of keyset pagination.

## Phase 2 comparison checklist

After blindness is lifted, compare the implementation/output against this list:

- top-screen verdict and grain are immediately clear;
- critical/wrong-result risks precede all performance advice;
- q07 remains conditional on intent;
- action bundles honor rewrite/index dependencies;
- q10 is a genuine no-performance-action result;
- measured, verified, predicted, and unknown states never blur;
- equivalence metadata and result checks are both preserved;
- all source fields that affect action or safety remain visible;
- empty/partial analyses degrade honestly and without exceptions;
- terminal/plain outputs are semantically equivalent and safe;
- ordering is deterministic and input is not mutated;
- no corpus ID, exact-query, or phrase-based special-casing exists.
