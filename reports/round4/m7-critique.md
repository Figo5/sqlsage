# M7 Round-4 independent critique — report renderer/prioritizer

## Review protocol and blind yardstick

- Read `docs/CRITIC-BRIEF.md` and `docs/EXPERT-SOURCES.md` completely before inspection.
- Adopted the frozen pre-implementation yardstick at `reports/round1/m7-reference.md`; it was not changed.
- Before reading current M7 output or `src/report/`, rechecked the corpus SQL/schema and raw q01, q05, q06, q07, and q10 plans. The plans confirm the yardstick anchors: q01 scans all orders and removes 650,521 rows per worker; q05 removes all 200,000 customers after a nullable `NOT IN`; q06 feeds 5.1M item-expanded rows into aggregation for 1.7M complete orders; q07 is planned as an ordinary nested loop and returns 149,000 rows; q10 pushes `customer_id < 1000` into `idx_orders_customer_id` and runs in about 6 ms.

## Evidence log

### Current artifact/source inspection

- Read the authoritative 2026-08-01 `HANDOFF.md`, the complete Round-3 M7 critique, current fixture output, all 35 focused tests, every file under `src/report/`, the shared `Analysis` contract in `src/types.ts`, and the producer in `src/index.ts`.
- The 2026-08-01 reverse coupling pass is structural: it follows exact `IndexRecommendation.id` via `indexSatisfies`; it does not inspect DDL text or index-name similarity. Its behavior outside the single-rewrite/single-index/single-finding case still needs adversarial proof.
- Source inspection already identifies four Round-3 non-headline concerns that appear unchanged and therefore require probes: `decideVerdict()` still gates on all `validationProblems` rather than rejected input only; `missingIndexFields()` and `indexSatisfies()` accept any nonblank DDL; correctness findings with `actionability:'none'` still suppress their remediation; and timing validation remains finite-only. The blocked-action bottom-line string also still opens bold Markdown without closing it.
- `Analysis.missingModules` is carried by `src/index.ts` and folded into `missingAnalysisParts()`. Proper nonblank array entries block a categorical verdict; malformed runtime values are not validated at the top level and need explicit characterization.

Adversarial probes are in progress. Passing tests will be treated as claims to verify, not as proof.

### Incremental probe checkpoint

`reports/round4/m7-coupling-probe.ts` is on disk and has already established:

- **Pass:** a q01-like rewrite with zero prose overlap is pulled beside its exact-ID index, and the first action is the coupled rewrite+index pair.
- **Pass:** when both an index and its rewrite attach to no finding, the orphan path keeps that single pair together.
- **Defect:** when two orphan rewrites require the same valid index, only the first synthetic issue receives the index. The second issue has no adjacent DDL, has no dependency blocker, yet M7 authors the statement that the index “is supplied immediately with this rewrite.”
- **Pass:** two rewrites sharing an index work when the index first attaches to a finding; both rewrites and the one index land in the same issue.
- **Pass:** one rewrite requiring two indexes works when one index initially attaches and the other is orphaned; the forward pass pulls both into the bundle. Missing and blank required IDs block the verdict rather than guessing.

The probe is being extended after correcting a critic-side fixture whose slug accidentally created prose affinity; no implementation conclusion depends on that failed assertion.

## Executive assessment

The new reverse pass fixes the exact q01 failure that motivated it: even with every rewrite/finding prose signal removed, the first action is now the deployable rewrite+index pair, and the measured-slower index never appears as an independent first step. That is a real, structurally grounded improvement.

It is not yet a general change-set model. The implementation still assigns each physical index object to one issue and consumes orphan indexes once. Shared dependencies, dependencies spanning more than one finding, and q07-like result-changing proposals expose false adjacency and false risk classification. Two older paths also still let M7 author confident falsehoods: arbitrary non-CREATE text receives `CREATE INDEX` locking advice, and an established intent branch can be described as unjustified because its intent finding lives in another issue.

Reproducible evidence is in:

- `reports/round4/m7-coupling-probe.ts`
- `reports/round4/m7-regression-probe.ts`
- `reports/round4/m7-determinism-generalization-probe.mjs`

All three complete with exit status 0; lines labeled `DEFECT` are asserted current behavior, not probe failures.

## Headline findings

### 1. HIGH — exact-ID coupling is still an issue-assignment side effect, not a first-class change set

`prioritize.ts:853-875` correctly reads declared edges in both directions only when all assigned dependencies point to one finding. `prioritize.ts:1007-1035` then creates orphan issues while `usedOrphanIdx` lets an index object be consumed by only one rewrite. Finally, `index.ts:558-579` says every valid, unblocked required ID “is supplied immediately with this rewrite” without checking whether that index is actually in the issue.

The adversarial neighborhood is mixed:

- **Correct q01-like case:** one rewrite, one index, one finding, zero prose overlap becomes one issue and one coupled first action.
- **Correct no-finding case:** one orphan rewrite plus one orphan required index remains one synthetic bundle.
- **Broken shared-index case:** two orphan rewrites require `ix_shared`; issue 1 contains rewrite A plus the index, issue 2 contains rewrite B alone. There are zero dependency blockers, and both rewrite sections say the index is supplied immediately.
- **Correct attached shared-index case:** if the same index happens to attach to a finding first, both rewrites land in that finding’s issue. Correctness therefore depends on incidental affinity state.
- **Broken split-target case:** one rewrite requires two valid indexes that attach to different findings. Refusing to select the more severe finding is right—severity is not relationship evidence—but the renderer then creates a third index-free rewrite issue and says both indexes are immediately supplied. The same failure occurs when severities tie.
- **Broken mixed case:** one required index is attached elsewhere, one is orphaned, one ID is missing, and one ID is duplicated. Missing and duplicate IDs are correctly blocked, but the rewrite issue contains only the orphaned index while the other valid ID is still described as immediately supplied.

When a single exact ID is duplicated across two recommendations, refusal is unequivocally correct regardless of severity or ties: the producer supplied an ambiguous identity, and choosing “the highest severity” would hide corrupt input. When one valid change set plausibly relates to two findings, neither severity nor stable input order proves ownership. Fixed means constructing connected components over exact rewrite/index edges first, rendering each component once as a deployable change set, and only then associating the whole component with zero, one, or several findings. A multi-finding component can say its relationship is ambiguous or spans both findings; it must never be split, and a shared index must remain visibly available to every dependent rewrite without duplicating its DDL as a separate recommendation.

### 2. HIGH — a q07-like orphan rewrite still invents the wrong headline and rejects a legitimate intent branch for the wrong reason

With one high/high `intent` finding (“the right-side filter removes unmatched rows”) and one zero-affinity `different-semantics` rewrite (“retain unmatched rows”), the model is:

```text
§1 correctness/high  findings=[]                    rewrites=[retain-unmatched]
§2 intent/high       findings=[outer-row-intent]    rewrites=[]
verdict: POSSIBLE WRONG RESULTS
```

The report leads with synthetic “Unjustified result-changing rewrite,” demotes the real query behavior to section 2, and states: “No attached correctness finding justifies that change; do not apply this rewrite yet.” The frozen q07 yardstick requires `INTENT REQUIRED` and two branches: retain unmatched rows by moving the predicate into `ON`, or make the inner semantics explicit if exclusion was intended. A correctness finding is not the prerequisite for an intent branch.

The source appears to know this is a bug: `Issue.semanticRiskElsewhere` is declared at `prioritize.ts:86-92` specifically to prevent a false claim about a risk elsewhere, but no returned issue ever populates it and the renderer never consumes it. A structurally coupled q07-like rewrite does render correctly as `INTENT REQUIRED`; again, editorial correctness depends on incidental attachment. Fixed means preserving the established intent verdict, presenting an unattached result-changing proposal as a branch that still needs intent confirmation, and never promoting it above a real intent finding merely because no safe finding relationship can be proved.

### 3. MEDIUM — malformed/non-CREATE DDL still satisfies dependencies and receives false M7-authored operational advice

`missingIndexFields()` (`prioritize.ts:371-376`) checks only that `ddl` is nonblank, and `indexSatisfies()` (`prioritize.ts:325-327`) repeats that weak test. Both `DROP TABLE generic.things;` and `-- TODO: write DDL` therefore satisfy an exact required ID, create a clean coupled action, and avoid `ANALYSIS INCOMPLETE`. `lockingNote()` then tells the reader that the payload is a regular `CREATE INDEX` which permits reads but blocks writes. That is confidently wrong for the destructive example and misleading for the comment.

`indexName()` already has the relevant `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS]` recognition grammar. Fixed means requiring an executable CREATE INDEX shape before the recommendation can satisfy a dependency or receive index-build advice; rejected DDL stays visible as malformed input and blocks deployability.

### 4. MEDIUM — recovered validation noise still suppresses a proven correctness verdict

The source declares `rejectedProblems` and `recoveredProblems` in `ReportModel` (`prioritize.ts:129-134`) but never returns either field (`prioritize.ts:1141-1155`). `decideVerdict()` still gates on `validationProblems.length` wholesale at line 1209. Thus an invalid optional access-path enum that is successfully rendered as `unknown`, or an out-of-range optional cost share that is safely omitted, changes a fully evidenced `WRONG RESULTS` input into `ANALYSIS INCOMPLETE`.

Conservative gating is correct when a finding, rewrite, required DDL, or other safety-bearing entry is rejected; the probe confirms such loss remains incomplete. Fixed means materializing the advertised split, gating only on rejected/safety-bearing loss, and listing recovered coercions under “How far to trust this” without letting a cosmetic M3 value outrank a proven result defect.

## Lower-priority gaps carried from Round 3

- **Correctness + `actionability:'none'` drops remediation.** The model correctly keeps a critical correctness issue and emits `WRONG RESULTS`, but `index.ts:501` deliberately suppresses the only supplied remediation, leaving no “Do this first” or “What to do.” No automated action does not mean no human next step.
- **Absurd finite timing ratios are called measured.** Overflowing arithmetic is now rejected, but `Number.MAX_VALUE -> 1 ms` renders a `1.7976931348623157e+308x speedup`, and `100 ms -> 1e-10 ms` renders `1000000000000.00x speedup`. The endpoints are finite, not plausible measurements. Fixed means a documented plausibility range or a verification contract that supplies trustworthy measurement bounds.
- **Blocked-report Markdown remains malformed.** The safety line opened at `prioritize.ts:1379` has only one `**` delimiter, so Markdown displays literal asterisks and terminal output leaks them too.
- **Malformed `missingModules` overclaims completeness.** Proper string arrays work exactly as contracted, but runtime values such as `'M4'` or `[42]` are silently treated like an assertion that every module ran. Given M7’s explicit runtime-boundary validation promise, invalid declarations should be visible malformed input rather than a clean report.

## Round-3 do-not-regress results

### Trust and structure

- **Pass:** hard binding errors block categorical output while warning-only binding leaves a valid correctness verdict intact.
- **Pass:** all six whitespace-only safety fields—finding evidence, impact, remediation, rewrite SQL, index DDL, and original SQL—produce `ANALYSIS INCOMPLETE`.
- **Pass:** empty DDL, missing exact IDs, blank required IDs, and duplicate IDs do not satisfy dependencies. Duplicate IDs are ambiguous; the renderer does not pick by severity.
- **Pass:** `Finding.category` and `Finding.actionability` are the only risk/action controls. Correctness-shaped or imperative prose cannot manufacture a verdict or action, and the old prose regex remains absent.
- **Pass:** exact valid IDs couple even when the physical DDL index name is unrelated. A matching DDL index name, ID prefix, relation/column overlap, and explicit prose/token overlap do not satisfy a different required ID.

### Rendering, calibration, and corpus anchors

- **Pass:** adaptive Markdown fences use lengths 4/5/7/11 for payload backtick runs 3/4/6/10; the independent fence walker found no escape.
- **Pass:** q10 remains `NO PERFORMANCE ACTION`, with the observed `Bitmap Index Scan on idx_orders_customer_id`, no action list, no proposed index, and explicit language that there is no full scan or speedup to win.
- **Pass:** q01-like zero-prose-overlap input leads with the rewrite+index pair, never the measured-slower index alone.
- **Pass:** proper nonblank `Analysis.missingModules` declarations are deduplicated/sorted and block the verdict. Absent, empty, and blank-only arrays do not over-fire. `src/index.ts` carries `M2`–`M6` inside `Analysis`, and rendering the current partial pipeline is `ANALYSIS INCOMPLETE` rather than healthy.
- **Pass:** terminal color is styling only: ANSI-stripped colored output is byte-identical to plain output for critical, q01, q10, and degraded cases.
- **Pass:** three independent Node processes produced the same terminal bytes (`sha256 d29d27d2e7094f1943cb1a602d14d3eb8a4d6360add35da4fcd64b441a4328d7`). Rendering and model construction do not mutate inputs.
- **Pass:** replacing schema `shop` with equal-length `mart` throughout the full q01 fixture preserves the complete structural model and yields byte-identical output after normalizing the schema token. Executable renderer source contains no q01–q12 ID, SQL fingerprint, or corpus anchor phrase. The lone `shop` stop token is inert; no special-casing deduction applies.

## Score rationale

| Axis | Weight | Score | Reasoning |
|---|---:|---:|---|
| Correctness | 40 | 29 | Corpus claims, q01, q10, evidence provenance, binding gates, and exact-ID rules are strong. Deductions are for the q07 misclassification/false justification, false adjacency claims across valid dependencies, and M7-authored CREATE INDEX advice over non-index payloads. |
| Completeness | 30 | 24 | The renderer preserves nearly all contract evidence and now handles the canonical q01 pair, but change-set multiplicity is incomplete and correctness remediation can disappear. |
| Clarity | 20 | 17 | The issue-centric report and first screen are excellent on supported shapes. Split bundles, the q07 synthetic leader, and broken blocked-line markup make important edge reports actively harder to follow. |
| Calibration | 10 | 8 | q10, missing verification, result mismatches, and ordinary timing comparisons are well calibrated. Recovered optional noise over-gates the verdict and absurd finite ratios are still labeled measured. |
| **Total** | **100** | **78** | No special-casing or q10 deduction. The score remains below senior sign-off because realistic valid inputs still produce confident M7-authored misstatements. |

## Final verification

- `node --test src/report/report.test.ts` — 35 pass, 0 fail.
- `node eval/dump-report.ts --first15` — all checks passed.
- `node eval/run.ts` — 12/12 compose cleanly, with M2–M6 honestly declared absent.
- All three Round-4 M7 probes complete successfully and assert the pass/defect neighborhood described above.
- Final read-only database check lists exactly eight `shop` indexes: six primary keys plus `idx_orders_customer_id` and `idx_order_items_order_id`. No database mutation was performed.

SCORE: 78
CONVINCED: no
BIGGEST_GAP: In src/report/prioritize.ts, make exact-ID rewrite/index connected components first-class change sets so q01-like, shared-index, and multi-index recommendations never split or falsely claim adjacency.
GAP_DETAIL: The narrow q01 reverse edge works, but two orphan rewrites sharing one index and one rewrite whose indexes attach to different findings still split into separate issues while M7 says every valid companion is “supplied immediately.” Choosing the highest-severity finding is not a valid repair because severity proves urgency, not relationship; duplicate IDs must remain blocked, and multi-finding bundles must remain intact without guessing an owner. Fixed means build exact-ID dependency components before finding affinity, render each component once, and derive adjacency prose only from the indexes actually present in that component; the same design must keep q07-like intent branches from becoming synthetic correctness leaders.
