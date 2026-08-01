# M7 Round 1 critique — report renderer and prioritization

## Scope and method

Phase 1 was frozen in `reports/round1/m7-reference.md` before implementation or
renderer output was inspected. For Phases 2–4 I then read all of `src/report/`, its
builder notes and tests, and `eval/dump-report.ts`; rendered all four fixtures in both
formats; ran the focused suite; and exercised adversarial variants for correctness
wording, verification regressions/zeroes/partial data, index dependencies, malformed
objects, terminal control bytes, determinism, and input mutation.

The existing focused suite passes 11/11. That is useful evidence, but the suite tests
only the paths its fixtures were written to satisfy. It contains q06-style fan-out,
q01-style sargability, q10-style no-action, and degraded input; it has no q05 or q07
fixture and no slower/zero/partial verification case.

## What meets the reference bar

- **q06 happy path is editorially excellent.** `WRONG RESULTS` is the first verdict,
  the 3x revenue error leads, performance explicitly waits, the semantics-changing
  rewrite is presented as the point rather than a failed equivalence check, and its
  SQL/caveats remain adjacent.
- **q01 is correctly bundled.** The half-open rewrite and
  `idx_orders_status_created_at_incl` form one first action; the report preserves the
  measured fact that the index alone did not change the sequential-scan plan and was
  slower. The competing partial index is visibly an alternative, not another index to
  install.
- **q10 is well calibrated.** It says `NO PERFORMANCE ACTION`, preserves the actual
  bitmap-index evidence, leaves the aggregate predicate in `HAVING`, and puts the
  same-plan rewrite under optional readability work. It does not manufacture an index.
- Conditional equivalence, different-semantics rewrites, index build locking/cost,
  low confidence, cleared findings, deferred observations, and unresolved binding
  errors are visible rather than silently dropped.
- Both formats are built from one block model. Output is deterministic, rendering does
  not mutate the input, and ANSI-stripped colored terminal output equals colorless
  terminal output on the supplied fixtures.
- The runtime source contains no corpus IDs, exact corpus SQL, fingerprints, or imports
  from fixtures. There is no direct corpus special-casing.

Those are substantial strengths. On the four curated fixtures the output often reads
like a senior review. The failures below are genericity and calibration failures in M7
itself, not bad facts supplied by an upstream fixture.

## Material gaps

### 1. Critical — correctness priority is inferred from magic prose, and both false negatives and false positives change the verdict

`src/report/prioritize.ts:113-221` searches `id + title + impact` for a fixed phrase
list. A hit is treated as decisive even if it is negated; absent a hit, only a small
set of shape words at severity `critical` qualifies. This is the module's load-bearing
decision, yet it is not represented in the shared contract.

Adversarial results using valid `Finding` objects:

- A q07-equivalent high-severity finding titled “WHERE predicate eliminates
  NULL-extended rows,” whose impact says the query behaves as an inner join and
  excludes customers lacking a complete order, was classified as `performance`. The
  banner confidently said: **“No correctness problems.”**
- A definite q06-equivalent critical finding titled “Aggregation occurs after a
  one-to-many join,” whose impact says each order total participates once per item and
  reported revenue exceeds true revenue, was also classified as `performance` and got
  the same false banner.
- Conversely, a performance finding titled “Duplicate rows increase sort work,” whose
  impact explicitly says the duplicates are intentional and the result is correct,
  matched the phrase `duplicate rows` and produced **`WRONG RESULTS`**.

This is fake generality: the current q06 fixture passes because its prose says
“over-counted,” not because M7 has a reliable correctness signal. The builder notes
acknowledge the weakness, but acknowledging it does not make the report safe. Correct
fix: add a structured result-risk/category field to `Finding` (for example
`kind: correctness | intent | performance`) and have M4 populate it. Until that field
exists, M7 must not make the absolute claim “No correctness problems” merely because a
phrase was absent. Add paraphrase tests for q05, q06, and q07 plus negated-wording tests.

### 2. Critical — verification arithmetic reports severe regressions as unchanged

`src/report/prioritize.ts:859-867` has only two timing branches: ratio >= 1.15 is a
speedup; everything else is “effectively unchanged.” It never checks for regression
and divides by `max(optimizedMs, 0.0001)`.

Observed adversarial output:

```text
baseline 100 ms, optimized 300 ms
=> “after the changes below 300 ms — effectively unchanged, which is the honest answer here”

baseline 100 ms, optimized 0 ms
=> “after the changes below 0.0 ms (1000000.0x)”
```

This is confident, action-driving wrongness created by M7, not an upstream analysis
error. It needs explicit improvement / noise-range / regression branches, positive
nonzero validation before division, absolute and percentage deltas, and focused tests
for faster, similar, slower, zero, negative, NaN, infinity, and missing endpoints. A
regression must be at least a warning and must never appear under a healthy verdict.

### 3. High — evidence provenance is incomplete and sometimes invented

- A baseline-only verification renders only “Measured baseline 100 ms”; it never says
  the optimized variant was not measured or result equivalence was not checked.
- With no `verification`, `src/report/prioritize.ts:934-944` states “No live database
  was available.” Absence of a field proves only that live verification was not
  supplied/run; M7 cannot know why.
- `ExecutionAnalysis` is a predicted-analysis contract, but issue notes are labeled
  `Runtime (62%)` and the section is “Where the time goes” without consistently saying
  predicted versus observed. A footer caveat does not repair a factual-looking claim
  several screens earlier.
- Captured plans are reduced to “plans captured”; the report does not expose a plan
  delta or identify what was actually verified.

The renderer should emit field-level states: baseline measured / optimized not
measured / results not checked / plans not captured, and label M3 values as predicted
unless the corresponding live evidence is actually associated.

### 4. High — index dependency resolution accepts substrings and hides unresolved requirements

Both `src/report/prioritize.ts:344-351` and `src/report/index.ts:167-172` treat a required
index string as satisfied when it is merely a substring of DDL. Changing q01's
requirement to nonexistent `idx_orders_status` falsely coupled it to
`idx_orders_status_created_at_incl` and told the user to create that index as the
required pair. Changing it to `idx_does_not_exist` left the first-screen action as the
rewrite alone; the missing dependency was not classified as unresolved/incomplete,
while unrelated attached indexes were described as “alternatives.”

Use an explicit stable index recommendation ID (the contract currently has none) or
an exact parsed index-name convention. Never use DDL substring or column-overlap
guessing to satisfy an explicit dependency. A missing reference must be a visible
action blocker in the lede.

### 5. Medium — degraded runtime objects and untrusted terminal text are not safe

`buildModel` validates array entries only as non-null objects
(`src/report/prioritize.ts:381-385`). A complete-looking analysis with `indexes: [{}]`
received `NO PERFORMANCE ACTION` and rendered `Missing index on undefined ()` rather
than a partial-analysis warning. Required nested values need validation at the
renderer boundary, or invalid entries need explicit rejection without placeholders.

The text path normalizes whitespace but never strips control bytes
(`src/report/index.ts:67-69`, `src/report/blocks.ts:42-64`). Inserting `ESC[31m` in the
semantic headline survives terminal rendering even with `color: false`. This permits
terminal escape injection from SQL comments or analyzer/user-controlled text and
invalidates the claim that colorless output has no ANSI. Sanitize C0/C1 controls
(preserving intended newlines/tabs only where appropriate) before styling; add an
adversarial fixture rather than testing only trusted strings.

### 6. Medium — the report is not fully self-contained and a few labels distort relationships

`analysis.sql` is never rendered, so the report cannot independently establish which
query was analyzed. The full q06 report is 161 Markdown lines, yet omits the original
SQL while repeating extensive derived detail. The first-screen action also calls every
remaining attached fix an “alternative”; in q06 the two remaining indexes are
supplements/tradeoffs, not alternatives to the correctness rewrite. The semantic
headline is at the top, but result grain is deferred far below the action sections.

Render the original SQL once after the lede/actions, put result grain in the executive
summary, and label remaining changes according to dependency/alternative/supplemental
role rather than counting all recommendations alike.

## Source audit

No automatic special-casing deduction applies: runtime files have no qIDs or exact
query branches. The two heuristic systems are nevertheless brittle:

- correctness relies on a corpus-shaped phrase dictionary;
- finding/rewrite/index grouping relies on identifier overlap, slug overlap, DDL
  substring matching, and union-find merging.

The source is candid about both weaknesses and keeps orphan recommendations visible,
which is better than silently dropping them. But source comments and notes repeatedly
claim shape-level generality that the paraphrase and prefix tests disprove.

## Scoring

Raw axes:

- Correctness: **34/40** — excellent fixture output, but generic correctness and timing
  paths can assert the opposite of the truth.
- Completeness: **26/30** — unusually rich issue/fix/caveat rendering; partial
  verification states, original SQL, and malformed-entry handling are missing.
- Clarity: **19/20** — impact ordering and local evidence are excellent; “alternatives”
  and late grain/provenance cause limited ambiguity.
- Calibration: **7/10** — q10 and low-confidence handling are strong; regression,
  predicted/observed, and no-verification language are not.

Raw score: 86. Mandatory deductions applied:

- **-25 confident and wrong:** a measured 3x regression is called “effectively
  unchanged,” and a zero optimized time becomes a fabricated million-fold speedup.
- **-15 missed correctness bug:** reasonable q06/q07 paraphrases are labeled
  performance and the banner states “No correctness problems.”
- No folk-wisdom deduction: q10 is handled correctly.
- No special-casing deduction: none was found.

SCORE: 46
CONVINCED: no
BIGGEST_GAP: In `src/report/prioritize.ts`, replace phrase-based correctness inference with an explicit structured result-risk field so q05, q06, and q07 always lead regardless of wording.
GAP_DETAIL: The current magic-phrase list classified a q07-equivalent high-severity outer-join finding and a q06-equivalent critical one-to-many aggregate finding as performance, producing the false banner “No correctness problems”; it also promoted an explicitly intentional duplicate-row performance finding to `WRONG RESULTS`. Fixed means `Finding` carries a structured correctness/intent/performance category populated upstream, M7 orders on that field without prose matching, and paraphrased/negated variants for all three correctness corpus cases retain the right verdict.
