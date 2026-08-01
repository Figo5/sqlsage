# M7 Round 3 critique — report renderer and prioritization

## Scope and method

I reused the frozen Round-1 blind reference (`reports/round1/m7-reference.md`) as the
yardstick and re-verified the corpus facts it depends on against the live PostgreSQL
16.14 instance before reading a line of `src/report/`:

```text
NOT IN  -> 0 rows;  NOT EXISTS -> 196,000 rows;  14,285 checkout events have customer_id IS NULL
q06 wrong_total 1,280,102,100,000 / correct_total 426,700,700,000 = 3.000000
q10 -> Bitmap Index Scan on idx_orders_customer_id, Index Cond: (customer_id < 1000), 9,990 rows
```

I then ran the builder's harness (`32 tests passed`, `dump-report: all checks passed`),
read all four fixtures in full, read `prioritize.ts`, `index.ts` and `blocks.ts`, and
wrote **my own** `Analysis` objects for q01, q05, q07 and q10 from the corpus SQL and the
ground-truth plans. Nothing in my probes imports `src/report/fixtures.ts`.

Reproducible evidence: `reports/round3/adv-m7.ts` (my q05/q07 analyses),
`reports/round3/q01.ts`, `reports/round3/probe1.ts` … `probe6.ts`.

## Round-2 failures: all four genuinely fixed, and not by faking the counterexample

| Round-2 gap | Probe | Result |
|---|---|---|
| Hard binding error + correctness finding still led `WRONG RESULTS` | A1 | `ANALYSIS INCOMPLETE`, reason "hard schema-binding errors" |
| — and does it over-fire on `warn`? | A1b | No: `warn`-level binding keeps `WRONG RESULTS`. Not a blanket gate. |
| Blank evidence / impact / remediation / rewrite SQL / index DDL / original SQL | A2 ×6 | All six, including **whitespace-only**, rejected → `ANALYSIS INCOMPLETE` |
| Exact-ID index with empty DDL satisfied a coupled dependency | A3 | Dependency unresolved; `Action blocked` in the lede |
| Required index ID matching nothing | A4 | `1 unresolved index dependency`, `BLOCKED —` action item |
| `actionability:'none'` + arbitrary remediation prose | A5 | Prose never becomes an action; finding lands in "Checked, no action needed" |
| Markdown fences vs backtick runs | F1 | Fence widths 4/5/7/11 for runs of 3/4/6/10. **Zero** payload lines escape their block. |
| `1 / Number.MIN_VALUE` → `Infinityx speedup` | E2 | `A paired comparison is unavailable (derived timing arithmetic was non-finite)` |
| Values below display resolution → fake `0.0 ms` | E2 | `1.00e-7 ms`, positivity preserved |

The Round-2 prose regex `noActionRemediation` is gone; `cleared` is now keyed on
`f.category === 'performance' && f.actionability === 'none'`. `classify()` returns
`f.category` verbatim. `indexSatisfies()` is exact-ID plus non-empty DDL. These are the
structured contracts the handoff demanded.

## No corpus special-casing

No query id, corpus SQL fragment, or input fingerprint appears in `index.ts`,
`prioritize.ts` or `blocks.ts`. The only corpus-flavored literal is `'shop'` in
`STOP_TOKENS` (`prioritize.ts:185`). I proved it inert: renaming the schema
`shop → warehouse` throughout a full analysis produced an identical verdict, identical
issue count, and identical rewrite/index attachment; **1 of 112** rendered lines differed,
and only because `clip()` truncates at a fixed character budget and the longer name moves
the cut point. No deduction.

---

# New material gaps

## 1. HIGH — the coupled change set breaks on well-formed input, and the first action a reader takes is the one measured to be slower

This is the module's own stated charter (`prioritize.ts:1-19`: *"an issue is 'one
underlying problem plus everything that addresses it'"*) and my reference's q01 acceptance
test. It fails on realistic input.

`rewriteAffinity()` (`prioritize.ts:291-305`) scores a rewrite against a finding using
only `rw.id`, `rw.title`, `rw.rationale` and `rw.equivalenceNotes` — it **never looks at
`rw.sql`**, the one field most likely to contain the finding's `evidence.sqlFragment`.
`indexAffinity()` by contrast has hard structural signals (`evidence.relation` vs
`idx.table` = +3, `evidence.column` vs `idx.columns` = +3). The asymmetry is systematic:
**indexes reliably attach, rewrites reliably do not.**

The declared structured dependency does not rescue it. The coupling repair at
`prioritize.ts:828-835` iterates `rwAssign` — it only runs when the *rewrite already
attached*. The orphan path at `prioritize.ts:970-977` only adopts indexes that are
*themselves* orphans (`orphanIdx.includes(...)`). Neither path covers "rewrite orphaned,
index attached", which is the common case.

### q01, as a senior engineer would supply it

My `Analysis` (`reports/round3/q01.ts`): one `performance` finding on `date_trunc()`, one
priority-1 index `idx_orders_status_created_at_incl`, one priority-1 rewrite carrying
`requiresIndexes: ['idx_orders_status_created_at_incl']`, `verification` 108.8 → 27.6 ms.
Nothing malformed. The model splits it:

```text
  §1 performance "date_trunc() on created_at makes the date filter unindexable"  rw=[] idx=[idx_orders_status_created_at_incl]
  §2 performance "Filter the raw created_at column with a half-open range"       rw=[half-open-month-range] idx=[]
  dependencyProblems = 0        <-- nothing warns
```

The first screenful (terminal, lines 1-26):

```text
ACTION NEEDED
No correctness or intent blocker was reported. There is evidence-backed
performance work to do.
...
Measured timing: 109 ms -> 28 ms, 81 ms faster (74.6%; 3.94x speedup).

Do this first
 1. Create idx_orders_status_created_at_incl on `shop.orders (status,
    created_at) INCLUDE (customer_id, total_cents)` — The planner falls back to
    a parallel sequential scan ... *(index · ~86 MB on 2,000,000 rows)*
 2. Filter the raw created_at column with a half-open range *(rewrite ·
    conditionally equivalent)*
```

A staff engineer skims that and does item 1. The authoritative paired experiment
(`HANDOFF.md`, ground truth) says the index alone is **1.04x slower, unused, and the plan
stays a sequential scan**. The `3.94x speedup` line sits three lines above the action that
does not produce it. The only statements that couple the two live at **line 93 and line 96
of 119** — five screens down:

```text
  line 56/119: 113.3 ms — 1.04x SLOWER, and the plan stayed a sequential scan.
  line 93/119: Expected effect (upstream): 3.94x, but only together with the companion
  line 96/119: Required companion index: idx_orders_status_created_at_incl is supplied
```

My reference's q01 acceptance test names this exact failure: *"The report fails this test
if it places the index under 'quick wins', separates the rewrite many screens away, or
describes either as independently yielding the measured 3.94x speedup."*

The machinery is present and excellent **when affinity happens to fire** — the builder's
own fixture renders one merged action, `*(coupled rewrite + index · conditionally
equivalent)*`. The defect is that firing depends on prose word overlap rather than on the
declared `requiresIndexes` edge. `HANDOFF.md` §4 is explicit that these structured fields
"deliberately replace weak-map/prose/DDL-substring workarounds… Do not reintroduce prose
inference." A declared dependency being subordinated to token overlap is that reintroduction.

### q07 — the same root cause produces a confidently wrong verdict

Well-formed input: one `intent` finding, `severity: high`, `confidence: high`, evidence
`WHERE o.status = 'complete'`; one `different-semantics` rewrite moving the predicate into
`ON`. The rewrite scores 1 against `ATTACH_THRESHOLD = 3` and orphans. `prioritize.ts:978-994`
then *manufactures* a synthetic issue:

```text
verdict = POSSIBLE WRONG RESULTS
issue#1 = correctness :: Unjustified result-changing rewrite — Move the status predicate into ON to keep unmatched customers
lede    = **Unjustified result-changing rewrite — Move the status predicate into ON to keep unmatched customers.**
```

Four things are wrong at once:

1. The verdict should be `INTENT REQUIRED` (my reference's q07 acceptance headline). It is
   `POSSIBLE WRONG RESULTS`.
2. The lede is a scold aimed at M6, not an analysis of the query. The real defect —
   "the WHERE clause turns this LEFT JOIN into an inner join" — is demoted to §2.
3. `fixBlocks` (`index.ts:549`) prints **"No attached correctness finding justifies that
   change; do not apply this rewrite yet."** That is confidently wrong about M7's own
   input: `findingSemanticRisk = findingCorrectness ?? findingIntent` (`prioritize.ts:896`)
   shows an intent finding *does* justify it. A reader would reject the correct rewrite.
4. The synthetic issue is force-typed `kind: 'correctness'` with `confidence: 'low'`, which
   is what drags the verdict to `POSSIBLE WRONG RESULTS`.

Phrasing sweep — 2 of 4 plausible authorings fail:

```text
[as authored]                                     -> POSSIBLE WRONG RESULTS  (synthetic issue leads)
[rationale mentions shop.orders]                  -> POSSIBLE WRONG RESULTS  (synthetic issue leads)
[rewrite id shares a slug token with finding id]  -> INTENT REQUIRED         (correct)
[evidence fragment verbatim in equivalenceNotes]  -> INTENT REQUIRED         (correct)
```

**Fixed looks like:** `rewriteAffinity` includes `rw.sql` in its text corpus; and before
the orphan pass, any rewrite whose `requiresIndexes` resolves to exactly one supplied
index is unioned into that index's issue (declared dependency outranks fuzzy affinity in
both directions). A `different-semantics` orphan must not be promoted to `correctness`
while any live correctness *or intent* issue exists in the report.

## 2. MEDIUM — recovered, cosmetic validation noise outranks a proven correctness defect

`decideVerdict` gates on `validationProblems.length` (`prioritize.ts:1160`). That list mixes
fatal rejections with problems the code explicitly *recovered from*. Each of these alone
demotes a confident, fully-evidenced `WRONG RESULTS` to `ANALYSIS INCOMPLETE`:

```text
[catalogName blank (cosmetic)]                             -> ANALYSIS INCOMPLETE (1 malformed field)
[execution.accessPaths[0].path typo -> rendered as unknown]-> ANALYSIS INCOMPLETE (1 malformed field)
[dominantCosts[0].estimatedShare = 1.5 -> ignored]         -> ANALYSIS INCOMPLETE (1 malformed field)
[a semantics step missing .detail -> entry ignored]        -> ANALYSIS INCOMPLETE (1 malformed field)
```

`prioritize.ts:491` literally pushes *"…was invalid and was rendered as unknown"* into the
same array that suppresses the safety verdict. Round 2 failed because trust lost to
verdicts; Round 3 over-corrected so that a typo in an optional enum outranks a query that
returns 0 rows instead of 196,000. The correctness lede paragraph survives, so the reader
is not blind — but the top-line status is now wrong in the other direction, and it makes
the gate trivially easy to satisfy in tests.

**Fixed looks like:** split `validationProblems` into `rejected` (an entry was dropped, a
required top-level field is unusable, a dependency is unresolved, an analysis part is
missing) and `recovered` (a value was coerced or an optional field ignored). Only
`rejected` suppresses a categorical verdict; `recovered` stays in "How far to trust this".

## 3. MEDIUM — a non-empty but non-DDL `ddl` satisfies a coupled dependency, and M7 attaches its own wrong safety prose to it

`missingIndexFields` checks `isNonEmptyString(value.ddl)` only. `"-- TODO: write the DDL"`
and `"DROP TABLE shop.events;"` both pass, both satisfy `indexSatisfies`, and both produce
a clean `WRONG RESULTS` report with `depProblems=0`:

```text
## Do this first
1. **Use NOT EXISTS ... and create the required index** *(coupled rewrite + index · changes results)*
> **Required companion index:** `idx_events_checkout_customer` is supplied immediately with this rewrite.
### Index (required dependency) — shop.events (customer_id) WHERE event_type = 'checkout'
DROP TABLE shop.events;
> **Before you run it:** A regular `CREATE INDEX` lets reads continue but blocks inserts,
  updates, and deletes on `shop.events` until the build finishes...
```

That last note is **M7's own authored prose** (`index.ts:136-143`), not upstream's, and it
is confidently wrong about a destructive statement. The brief asked for "empty **or
malformed** DDL"; empty is fixed, malformed is not — the reported case was patched and the
family left open. The module already owns the correct test: the `CREATE [UNIQUE] INDEX
[CONCURRENTLY] [IF NOT EXISTS] <name>` regex in `indexName()` (`index.ts:100`).

**Fixed looks like:** `missingIndexFields` requires `ddl` to match that regex; a
non-matching DDL is a rejected recommendation and therefore cannot satisfy
`requiresIndexes`.

## 4. MEDIUM-LOW — `correctness` + `actionability:'none'` is a dead-end report

A critical, high-confidence correctness finding with `actionability: 'none'` and no
rewrite or index yields:

```text
> ## WRONG RESULTS
> This query returns wrong answers today. Fix that before you spend a minute on its speed.
```

…and then nothing. No "Do this first". The contract field `remediation` ("Replace NOT IN
with NOT EXISTS after confirming the intended population") is **silently discarded** —
`index.ts:501` gates the note on `lead.actionability !== 'none'`. `actionItem` already
contains the right string for this state, `'correctness · no safe automated fix'`
(`index.ts:268`), but `isActionable()` returns false so it is unreachable. Telling a reader
their query is wrong and withholding the one sentence you have about fixing it is worse
than either alternative.

## 5. LOW — derived timing sanity is finite-only, so the literal counterexample is fixed and the class is not

`compareTimings` revalidates with `Number.isFinite` (`prioritize.ts:621`). `1 /
Number.MIN_VALUE` overflows to `Infinity` and is correctly rejected. Values that stay
finite are not:

```text
Number.MAX_VALUE -> 1 :  Measured timing: 1.7976931348623156e+305 s -> 1.0 ms,
                         1.7976931348623156e+305 s faster (100.0%; 1.7976931348623157e+308x speedup).
100 ms -> 1e-10 ms    :  Measured timing: 100 ms -> 1.00e-10 ms, 100 ms faster (100.0%; 1000000000000.00x speedup).
```

`toFixed(2)` on `1.79e308` emits exponential notation into a sentence that says
"Measured". The Round-2 gap asked for values "below display resolution" to be treated as
unavailable too. **Fixed looks like:** a plausibility band on the ratio (e.g. reject
outside 1e-6…1e6) and on absolute durations, rendered as `comparison unavailable` rather
than as a measurement.

## 6. LOW — the loudest safety line in a blocked report has broken markup

`composeBottomLine` (`prioritize.ts:1329-1333`) opens `**Action blocked — …` and never
closes it. Both formats show the literal asterisks:

```text
markdown: **Action blocked — required index ID `idx_nope` was not supplied. Do not deploy the dependent rewrite until...
terminal: **Action blocked — required index ID idx_nope was not supplied. Do not deploy
```

---

# What is genuinely good

I built these cases myself; none is a builder fixture.

- **q10, the folk-wisdom trap — handled correctly.** `NO ACTION NEEDED`; *"Nothing to
  change for performance: The non-aggregate HAVING predicate is already pushed to an index
  scan; count(\*) > 5 cannot be moved out of HAVING."* 55 lines total, **no speedup claim,
  no proposed index**, and baseline-only verification honestly reported as "optimized not
  measured". This is exactly the one-line answer my reference demands, and it is the
  hardest thing on the rubric to get right.
- **q05 leads with the wrong answer, not the runtime.** `WRONG RESULTS`, then the 14,285
  NULLs and 0-vs-196,000 in the lede sentence, then timing. `resultsMatch: false` is framed
  as *expected* for a `different-semantics` repair, with the correct caveat that the new
  rows still need validating against business intent.
- **`resultsMatch: false` on an `exact` rewrite with no correctness finding** → `RESULTS
  CHANGED` / *"Do not ship it until that difference is reconciled."* Correctly loud.
- **Verification provenance is field-level and honest** — measured/predicted/not-captured
  never blur, and the renderer refuses to infer a plan delta from two opaque payloads.
- **Determinism and format parity**: identical SHA-256 across three separate processes;
  ANSI-stripped terminal is byte-for-byte the plain terminal output; input is not mutated;
  `NO_COLOR`, `TERM=dumb`, `FORCE_COLOR=0` and non-TTY all degrade correctly (and
  `NO_COLOR=""` correctly does *not* disable colour, per the no-color spec).
- **Adaptive fences are real**, verified against runs of 3, 4, 6 and 10 backticks with a
  fence-state walker. My first check reported a leak; it was my test that was wrong, not
  the code.
- The issue-centric document architecture — evidence before argument, DDL and caveats
  attached to the code they qualify, "Checked, no action needed", relationship badges
  (`required dependency` / `alternative` / `supplement`) — is better than most human-written
  reports. That is what makes gap 1 worth fixing rather than worth rewriting.

---

# Score

| Axis | Weight | Score | Reasoning |
|---|---:|---:|---|
| Correctness | 40 | **29** | No claim about PostgreSQL 16 is wrong, and the corpus facts survive checking. But M7's own authored prose is wrong in two places on realistic input: "No attached correctness finding justifies that change" when a high/high intent finding does (gap 1), and `CREATE INDEX` locking advice printed over a `DROP TABLE` (gap 3). Absurd finite ratios are labeled "Measured" (gap 5). |
| Completeness | 30 | **21** | Every contract field is preserved and rendered — except `remediation` under `actionability:'none'` (gap 4). The real loss is structural: the q01 coupled change set, the module's own charter and a named corpus anchor, is split on well-formed input with no warning (gap 1). |
| Clarity | 20 | **16** | Ordering, evidence attachment, section design and the "Checked, no action needed" section are excellent. Against that, the q01 first screenful actively misleads, and the blocked-dependency line — the loudest safety statement in the document — has broken markup (gap 6). |
| Calibration | 10 | **9** | q10, q05, the ±15% noise band, and measured-vs-predicted labeling are all right. Deducted for the incomplete-gate over-trigger (gap 2) and finite-but-absurd ratios (gap 5). |
| | | **75** | |

No special-casing deduction. No folk-wisdom deduction — q10 is handled correctly. No
missed-correctness-bug deduction — q05, q06 and q07 correctness inputs are all classified
and led with correctly *when the analysis is attached properly*; the q07 miscategorisation
is charged to gap 1 rather than double-counted here.

SCORE: 75
CONVINCED: no
