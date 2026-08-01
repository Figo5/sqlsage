# M7 Round 8 critique — report rendering and prioritization

## Protocol compliance and frozen blind baseline

I followed the required blind order. I first read `docs/CRITIC-BRIEF.md` and
`docs/EXPERT-SOURCES.md` in full. Before opening any current M7 output or source,
builder notes, later critique, progress report, or handoff narrative, I then read and
independently adopted the complete Round 1 M7 reference as the Round 8 yardstick.
The frozen copy is `reports/round8/m7-reference.md`; its SHA-256 is
`91124b1038e51203c5654b23ba02de9a019a6b418c3f160b60191a2dedc55bd3`, identical to
`reports/round1/m7-reference.md` at review start. Only after freezing that file did I
begin Phase 2 comparison. No current implementation information influenced this
baseline.

The reference judges the whole renderer/prioritization module: executive hierarchy,
correctness-first ordering, coupled rewrite/index actions, evidence provenance,
verification calibration, malformed-input behavior, terminal/plain parity and safety,
determinism, and absence of corpus-specific branches or phrase heuristics.

## Evidence log

Evidence and commands are recorded below incrementally as the review proceeds.

### Database safety baseline

Before any live DDL probe, I ran:

```bash
docker exec sqlsage-pg psql -U postgres -d sage -X -v ON_ERROR_STOP=1 -Atc \
  "SELECT count(*) FROM pg_indexes WHERE schemaname = 'shop';
   SELECT indexname || E'\\t' || indexdef
   FROM pg_indexes WHERE schemaname = 'shop' ORDER BY indexname;"
```

It returned exactly **8** persistent indexes: six table primary-key indexes plus
`idx_order_items_order_id` and `idx_orders_customer_id`
(`categories_pkey`, `customers_pkey`, `events_pkey`,
`idx_order_items_order_id`, `idx_orders_customer_id`, `order_items_pkey`,
`orders_pkey`, `products_pkey`). All live DDL in this review will use TEMP objects or
`BEGIN`/`ROLLBACK`; `CREATE INDEX CONCURRENTLY` will not be executed. A matching final
count is required before verdict.

### Current artifact and preserved gates

After lifting blindness I read the complete current report implementation, shared
contract, fixtures/tests, evaluator, all earlier M7 critiques and probes, and the current
builder notes/handoff. The Round 8 source change is narrow: the `--` scanner in
`src/report/index-ddl.ts` now stops at either `\n` or `\r`; the report model and
renderer retain their prior structure. Source inspection found no branch on q01–q12,
exact corpus SQL, or corpus anchor prose. The only literal `shop` in the prioritizer is
an inert stop token already covered by the schema-rename probe.

Preserved commands and results:

```bash
node --test src/report/report.test.ts
# 48 pass, 0 fail

node eval/dump-report.ts --first15
# all fixture and invariant checks passed

node eval/run.ts
# 12/12 compose; output explicitly declares M2-M6 absent

node reports/round5/m7-component-adversarial-probe.ts
# exits 0: dependency graph gates pass; repeated-ID note defect remains

node reports/round5/m7-q07-global-risk-probe.ts
# exits 0: q07 target passes; unrelated-global-intent defects remain

node reports/round4/m7-determinism-generalization-probe.mjs
# exits 0: ANSI/plain parity, cross-process determinism, non-mutation,
# schema rename, and special-casing audit pass

node reports/round7/m7-known-gaps-and-gates-probe.ts
# exits 0 while asserting all known pass/defect neighborhoods
```

The preserved non-DDL probe reconfirms five unwaived defects: malformed runtime
`missingModules` values can assert completeness; safely recovered optional M3 noise
gates a proven correctness verdict as incomplete; correctness plus
`actionability: none` hides the supplied remediation; implausible positive finite timing
ratios are called measured speedups; and the blocked-action bottom line has unmatched
Markdown emphasis. The component probe also reconfirms repeated exact-ID companion
notes, and the q07/global-risk probe reconfirms that unrelated intent elsewhere can
classify and describe an opaque result-changing proposal as an intent-confirmation
branch chosen by input order.

### Round 8 statement-identity repair: live PostgreSQL 16 evidence

I saved `reports/round8/m7-line-boundary-pg16-probe.ts` before running it. The probe
uses the Node PostgreSQL driver so each complete DDL string reaches the backend parser
as one query, rather than relying on a client-side file splitter. Every case begins a
transaction, creates only `TEMP m7_line_boundary`, runs ordinary (never concurrent)
index DDL, counts temporary indexes when parsing succeeds, and rolls back. It runs all
cases before the aggregate assertion.

```bash
node reports/round8/m7-line-boundary-pg16-probe.ts
# MATRIX cases=44 serverAccepted=32 serverSyntaxRejected=12
# recognizerAccepted=29 failures=0
# SHOP_INDEXES 8 -> 8
```

For **LF, CRLF, and bare CR** independently, the matrix covers a trailing comment,
leading and inter-token comments, invalid executable payload after both a terminated
and unterminated index definition, a second valid index statement, and comment-like
bytes inside ordinary strings, dollar strings, block comments, nested block comments,
and quoted identifiers. PostgreSQL exposes payload after each real line ending; M7
rejects it. PostgreSQL executes two indexes when a second valid statement follows;
M7 correctly rejects that input because its contract is exactly one statement.
Protected lexical contexts remain accepted on both sides. NEL, Unicode line/paragraph
separators, form feed, and vertical tab are correctly *not* treated as PostgreSQL
line-comment endings; mixed CR/LF sequences stop at the first real boundary.

The saved Round 7 100-case differential matrix was also rerun unchanged. It completed
all 100 cases with **0 false accepts**, 18 conservative false rejects, 60 agreement
rejects, and 22 recognizer accepts that executed or reached only semantic/catalog
checks. It then exited 1 only at its deliberately stale assertion that the bare-CR
payload should still be accepted (`false !== true`). Its eight saved Round 6 false
accepts, nine broad live-valid controls, and position-sensitive `CONCURRENTLY` signal
all passed before that stale line. No concurrent DDL was executed.

### Model construction and renderer revalidation

I saved `reports/round8/m7-line-boundary-renderer-probe.ts` before running it. It uses
a critic-authored generic `Analysis`, not a corpus fixture or ID. For each line ending
it tests trailing comments, executable and second-statement payloads, plus ordinary
string, dollar-string, and block-comment protection. All model cases and then all
stateful renderer cases run before aggregate assertions.

```bash
node reports/round8/m7-line-boundary-renderer-probe.ts
# MODEL_MATRIX cases=18 accepted=12 rejected=6 failures=0
# RENDER_MATRIX cases=18 failures=0
```

At normal construction, every exposed payload is dropped before component formation,
its exact-ID dependency becomes missing, the verdict becomes incomplete, and neither
the payload nor coupled-action/build-lock prose renders. Every protected/trailing-only
control retains the dependency and ordinary build warning. At the renderer's lowest
public path, a getter supplies valid DDL during model construction and substitutes each
test case only inside `fixBlocks()`: every invalid LF/CRLF/CR payload receives `DDL
rejected` with no payload or locking guidance, while protected and trailing-only cases
remain accepted. The unchanged Round 7 renderer probe likewise passes all eight saved
grammar defenses and ordinary arbitrary-payload defenses, then exits only at its stale
`valid === true` bare-CR expectation.

This closes the Round 7 confident-wrong statement-identity defect. I found no current
false accept in that boundary and therefore apply no confident-wrong deduction for the
Round 8 repair itself.

### Fresh generalization of all unresolved findings

I saved `reports/round8/m7-unresolved-generalization-probe.ts` before running it. The
probe uses generic critic-authored analyses and TEMP-table DDL, runs every case in each
family before aggregate assertions, and exits 0 only when the saved defects are
independently reproduced.

```bash
node reports/round8/m7-unresolved-generalization-probe.ts
# MALFORMED_MODULES variants=7 categoricalClean=6 mixedIncomplete=1
# RECOVERED_NOISE 5 incomplete-overfire defects
# HIDDEN_REMEDIATION 2 category variants
# IMPLAUSIBLE_TIMINGS 4 measured-ratio defects
# 7 representative live-valid PostgreSQL forms remain safe false rejects
# SHOP_INDEXES 8
# PASS all saved unresolved gaps independently reproduced and generalized
```

Ranked remaining defects:

1. **High — malformed `missingModules` can manufacture a clean bill of health.**
   `validateTopLevel()` never validates this field, and `missingAnalysisParts()` acts
   only when it is already an array. Runtime values `'M4'`, `42`, `null`, an object,
   `[42]`, and `[null, '']` all produce the categorical clean verdict and the banner
   “No actionable problem was found in the complete analysis.” A mixed `['M4', 42]`
   does become incomplete only because the valid string survives; the invalid member is
   still silently ignored. This is not merely conservative formatting: if M4 did not
   run on q05 or q06, the renderer can bless a wrong-result query as complete.

2. **Medium-high — valid PostgreSQL 16 DDL is rejected, sometimes with false syntax
   diagnostics.** The fresh live probe executes all seven representatives inside
   rolled-back TEMP transactions while M7 rejects every one: a value-less storage
   option, positive/signed-exponent storage values, an adjacent dollar-quoted storage
   value, a valid column-name keyword key, and dollar quotes adjacent to a predicate or
   expression operator. Reasons include “index key list is empty or incomplete,”
   “WHERE predicate is empty, incomplete, or unbalanced,” and “not valid PostgreSQL
   syntax,” all contradicted by server execution. The saved 100-case matrix records 18
   safe false rejects in total, including documented operator-class parameters and
   valid `E`/`U&` forms. Conservative deployment refusal is safer than false acceptance,
   but calling executed syntax malformed blocks legitimate M5 output and is still a
   confident factual error.

3. **Medium — recovered optional presentation noise outranks proven correctness.** Five
   generalized cases—an unknown access-path enum, a negative optional row estimate, an
   unknown join algorithm, an out-of-range cost share, and an unknown estimation
   direction—are safely coerced or omitted, yet every one changes a high-confidence
   `WRONG RESULTS` input to `ANALYSIS INCOMPLETE`. `ReportModel` declares separate
   `rejectedProblems` and `recoveredProblems`, but `buildModel()` returns neither and
   gates on the undifferentiated `validationProblems` list. Safety-bearing rejection
   should gate; recovered display noise should remain a trust note.

4. **Medium — `actionability: none` suppresses the supplied human next step.** The
   generalized probe reproduces this for both correctness and intent. The verdict still
   says wrong results or intent required, but `issueBlocks()` withholds the mandatory
   `Finding.remediation`, leaving no action list and no “what to investigate” note.
   “No automated/concrete action established” does not authorize discarding the only
   safe follow-up supplied upstream.

5. **Medium — finite-only timing validation confers false measurement authority.** The
   renderer calls `Number.MAX_VALUE -> 1`, `100 -> 1e-10`, `1e-10 -> 100`, and
   `1e12 -> 1e-6` measured speedups/regressions with precise ratios. Positive finite
   arithmetic is not enough to establish that a duration is within any possible timer's
   range or resolution. A plausibility/measurement contract is needed before these
   values receive “measured” authority.

6. **Medium-low — unrelated intent still leaks into an opaque result-changing branch.**
   With an intent finding on `unrelated.audit_rows.retention_code` and a zero-affinity
   customer-population rewrite, M7 classifies the rewrite as an intent branch and says a
   material intent finding elsewhere establishes “the population” is unsettled. No exact
   edge or affinity proves that relationship; multiple intent findings make the selected
   metadata depend on input order. The q07 target itself remains correctly ordered, but
   an additive `addressesFindingIds` edge is needed before prose may relate an orphan
   branch to a specific semantic risk.

7. **Low — safety prose still has deterministic presentation defects.** Repeating the
   same exact index ID three times renders one DDL block but three identical companion
   notes. A missing dependency's bottom-line Markdown contains one unmatched `**`, and
   the literal asterisks leak into plain terminal output. These are not safety-equivalent
   to the findings above, but they damage the loudest action-blocking line.

### Preserved senior-quality behavior

The failures above do not erase the substantial working architecture. Structured
`Finding.category` and `actionability` control q05/q06/q07 ordering without phrase
matching; q10 remains a genuine no-performance-action result; q01-style exact-ID
rewrite/index components stay adjacent across chain, star, shared-index, and multi-index
shapes; binding errors, blank safety fields, missing dependencies, verification mismatch,
and ordinary invalid DDL remain visible blockers. Measured/predicted/unverified states,
result mismatch semantics, index costs, SQL/DDL, grain, and provenance are generally
preserved. Markdown fences and terminal controls are safe, ANSI/plain content matches,
output is deterministic and non-mutating, and the schema-rename/source audit found no
corpus special-casing.

### Database safety closeout

After every saved and fresh probe I reran the original read-only inventory command. It
again returned exactly **8** persistent `shop` indexes with the same names as the
baseline. Every live index was on a TEMP object inside `BEGIN`/`ROLLBACK`; no
`CREATE INDEX CONCURRENTLY` was executed and no corpus timing measurement was run.

## Rubric and mandatory deductions

| Axis | Score | Rationale |
|---|---:|---|
| Correctness | 31/40 | Core correctness/intent ordering, exact dependencies, provenance, and the repaired PostgreSQL line boundary are strong. False completeness on malformed module metadata, false diagnostics for server-executed DDL, unrelated intent framing, and implausible measured claims remain factual failures. |
| Completeness | 23/30 | The report preserves most material valid input and the component model is mature. Valid DDL can disappear, manual correctness/intent remediation can disappear, and the advertised recovered/rejected split is absent. |
| Clarity | 17/20 | The first screen and issue-centric bundles are usually excellent. Misdiagnosed valid syntax, duplicated dependency notes, unrelated branch prose, and unmatched safety emphasis reduce precision. |
| Calibration | 5/10 | q10, ordinary verification, prediction labels, and conservative invalid-DDL handling are well calibrated. False completeness, extreme “measured” ratios, and whole-verdict over-gating on recovered M3 noise are not. |

Raw axis total: **76/100**.

- **−25 confident and wrong.** Applied once, not stacked: malformed module-presence
  metadata yields an absolute “complete analysis” clean verdict, and several DDL strings
  PostgreSQL 16 executes are described as empty/incomplete/invalid syntax. These are
  M7-authored factual claims that change whether the reader trusts or can deploy the
  report.
- **No −15 folk-wisdom deduction.** q10 remains correctly no-action on PostgreSQL 16.
- **No −15 missed-correctness deduction.** Given valid structured inputs, q05 and q06
  lead as correctness blockers and q07 leads as intent required.
- **No special-casing deduction.** The source and rename audits found none.

The mandatory deduction produces **51/100**. This is not senior sign-off despite the
real Round 8 repair: `CONVINCED` also independently fails because confident-wrong claims
remain.

SCORE: 51
CONVINCED: no
BIGGEST_GAP: In `src/report/prioritize.ts`, validate `Analysis.missingModules` at runtime so q05/q06 with an omitted M4 stage can never receive a categorical clean verdict from malformed module-presence metadata.
GAP_DETAIL: The fresh probe shows six malformed values—including `'M4'`, `42`, `null`, an object, `[42]`, and `[null, '']`—all render “No actionable problem was found in the complete analysis.” That claim can bless a wrong-result query when the correctness stage did not run, and it is more dangerous than conservatively rejecting valid DDL. Fixed means only `undefined` or an array containing exclusively valid nonblank module-name strings is accepted; every other value or malformed array member forces `ANALYSIS INCOMPLETE`, preserves candidate risks below, and names the invalid declaration under trust limits.
