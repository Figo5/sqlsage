# M7 Round 2 critique — report renderer and prioritization

## Scope and method

I reused the frozen Round 1 reference and critique, then inspected the revised shared
types and every file under `src/report/`. I reran all 26 focused tests, all four report
fixtures in Markdown and terminal form, the dump-report checks, and the Round 1
adversarial cases. I also tried nearby variants for blank-but-typed required fields,
hard binding errors combined with findings, no-action wording, hostile Markdown code
fences, and extreme finite timing values. The official suite and dump-report checks
both pass completely.

## Round 1 gaps that are genuinely fixed

- `Finding.category` is now the sole correctness/intent/performance classifier. The
  old correctness phrase dictionary is gone. Paraphrased q05/q06/q07 cases and
  correctness-shaped or negated performance prose retain the structured category.
- `IndexRecommendation.id` is now a shared-contract field, and
  `Rewrite.requiresIndexes` resolves by exact ID only. Prefixes, DDL substrings,
  missing IDs, and duplicate IDs no longer silently couple an action.
- Ordinary timing states are calibrated correctly: faster, within the +/-15% noise
  range, regression, zero, negative, non-finite, and missing endpoints all produced
  the expected result. A 100 -> 300 ms test now leads with `MEASURED REGRESSION`.
- Verification provenance is field-level. Baseline-only, plan-only, results-only,
  paired-plan, and absent-verification cases say exactly what was and was not checked.
  Predicted execution is labeled predicted.
- Malformed object-shaped entries are rejected visibly; C0/C1/ANSI bytes are escaped;
  the result grain is in the executive summary; original SQL is rendered once; and
  dependency, alternative, and supplement labels are accurate on the q01/q06 fixtures.
- q06, q01, q10, and degraded happy paths remain strong. Output is deterministic,
  color-invariant in content, non-mutating, and free of placeholder values on tested
  inputs.

No corpus IDs, corpus SQL fragments, or query-specific runtime branches were found in
`src/report/`. There is no automatic special-casing deduction.

## Remaining material gaps

### 1. High — trust and validity gates still lose to categorical verdicts

`decideVerdict` checks confident correctness and intent before hard binding errors,
validation problems, and unresolved dependencies (`src/report/prioritize.ts:1103-1160`).
That contradicts the frozen requirement that a hard binding error make the first
status `ANALYSIS INCOMPLETE` and downstream advice provisional. Adding an error-level
binding failure to the otherwise valid fan-out case still produced `WRONG RESULTS`;
the unresolved binding appeared only near the end under “How far to trust this.”

The runtime validators also confuse “is a string” with “contains the required fact”:

- A critical correctness finding with empty `evidence.sqlFragment`, `impact`, and
  `remediation` passed validation and produced the absolute verdict `WRONG RESULTS`.
- An exact-ID required index with `ddl: ''` satisfied the dependency and produced a
  first-screen “coupled rewrite + index” action. Only later did its detail section say
  `DDL missing`.
- A rewrite with `sql: ''` remained a deployable-looking first action but rendered no
  rewritten SQL.
- A complete-shaped analysis with both original SQL strings empty produced
  `NO ACTION NEEDED`; only the later SQL section admitted that no statement was
  available.

The source cause is the use of `isString` rather than `isNonEmptyString` for these
safety-critical fields (`src/report/prioritize.ts:330-384,406-408`). This is not merely
cosmetic malformed-input handling: it can manufacture a confident correctness verdict
from no evidence and declare an unusable dependency deployable.

### 2. Medium — one prose heuristic still turns “do nothing” into an action

Correctness inference is structured now, but actionability still relies on the
`noActionRemediation` phrase regex (`src/report/index.ts:206-218`). A valid medium
performance observation whose remediation was “No performance change is justified.”
produced `MINOR ISSUES`, a `Do this first` section, and the action:

```text
1. No performance change is justified. (code change)
```

This is internally contradictory and is a nearby paraphrase of the q10 no-action
language. Actionability needs a structured signal or should require a concrete
rewrite/index for a performance finding, rather than another expanding phrase list.

### 3. Medium — SQL can terminate its Markdown fence

C0/C1 terminal sanitization is fixed, but Markdown structure is not. An original SQL
string containing a run of three backticks rendered inside a fixed triple-backtick
fence (`src/report/blocks.ts:182-184`), closing the block early and allowing following
SQL/comment text such as `# injected heading` to become report markup. Use a fence
longer than the longest backtick run in the payload, or an equivalent safe code-block
encoding. This affects original SQL, rewrite SQL, DDL, and long evidence fragments.

### 4. Low — derived timing arithmetic can overflow after valid endpoint checks

Positive finite endpoints are accepted, but derived `deltaPct` and `ratio` are not
revalidated (`src/report/prioritize.ts:596-615`). Extreme finite pairs such as
`1 / Number.MIN_VALUE` therefore print `Infinityx speedup`; tiny positive values also
format as `0.0 ms`. These values are unrealistic as wall-clock measurements, but the
renderer promised that invalid comparisons never leak `Infinity` or a fake zero.
Treat non-finite derived values, and values below display resolution, as an unavailable
comparison or format them without losing positivity.

## Score

- Correctness: **35/40** — primary verdict/category/dependency/timing paths are fixed,
  but incomplete evidence can still support an absolute wrong-results claim.
- Completeness: **26/30** — the report preserves nearly every valid field and degraded
  object case, but blank required SQL/evidence/DDL bypasses completeness checks.
- Clarity: **18/20** — hierarchy and relationship labels are excellent; hard binding
  uncertainty is buried and the no-action paraphrase becomes a first action.
- Calibration: **8/10** — normal measurements and provenance are strong; invalid trust
  precedence and derived numeric overflow remain.

SCORE: 87
CONVINCED: no
BIGGEST_GAP: In `src/report/prioritize.ts`, make trust/validity gating precede categorical verdicts and reject blank safety-critical evidence, SQL, and DDL.
GAP_DETAIL: A hard binding error combined with a correctness finding still leads `WRONG RESULTS`; an empty evidence/impact/remediation finding also leads `WRONG RESULTS`; and an exact-ID index with empty DDL is treated as a satisfied coupled dependency. Fixed means error-level binding failures, malformed required fields, and unresolved dependencies force `ANALYSIS INCOMPLETE` before any categorical verdict; required analysis SQL, finding evidence/impact/remediation, rewrite SQL, and index DDL are non-empty; invalid indexes cannot satisfy dependencies; and provisional risks remain visible below the incomplete banner.
