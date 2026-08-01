# M7 Round-5 independent critique — report renderer/prioritizer

## Blind yardstick and corpus recheck

I adopted the frozen pre-implementation yardstick in `reports/round1/m7-reference.md`
before reading any current M7 output, implementation, or tests. I also reread
`docs/CRITIC-BRIEF.md` and `docs/EXPERT-SOURCES.md` in full and rechecked the raw
corpus SQL, schema, catalog, and ground-truth plans that support the yardstick.

The decisive anchors remain factual: `events.customer_id` is nullable; q01 scans all
2M orders and removes 650,521 rows per worker; q05 returns zero rows after filtering
all 200k customers; q06 aggregates after the item fan-out; q07's actual plan is an
ordinary nested loop and returns 149k rows; q10 already applies `customer_id < 1000`
through `idx_orders_customer_id`; and q11 executes its correlated aggregate 2M times.
The frozen standard is therefore unchanged: M7 must preserve upstream evidence and
epistemic status, lead with real correctness risk, keep exact rewrite/index dependency
components deployable, and degrade honestly on malformed runtime inputs.

## Incremental evidence log

This section is intentionally written as inspection proceeds.

### Baseline and inherited-gap checkpoint

- `node --test src/report/report.test.ts`: 39/39 pass.
- `node eval/dump-report.ts --first15`: all checks pass.
- `node eval/run.ts`: 12/12 compose, and the output explicitly declares M2–M6 absent.
- Report syntax checks pass; the database contains exactly eight `shop` indexes.
- The Round-4 regression and determinism/generalization probes still exit 0.
- The stale Round-4 coupling probe now exits 1 at its old-defect assertion because the
  second shared-index rewrite correctly contains the index. This is expected evidence of
  the repair, not a current test failure.

All six unwaived lower gaps are independently reproduced unchanged by the saved Round-4
regression probe: malformed/non-CREATE DDL is accepted and receives `CREATE INDEX` lock
advice; recovered optional validation noise suppresses `WRONG RESULTS`; correctness plus
`actionability:'none'` hides remediation; absurd finite ratios are labeled measured;
blocked Markdown has one unmatched `**`; and malformed runtime `missingModules` values
are silently treated as completeness.

### Exact-ID component probe checkpoint

`reports/round5/m7-component-adversarial-probe.ts` exits 0. The core Round-5 repair is
real beyond builder fixtures: the chain `A -> X <- B -> Y <- C` stays one component under
12 ordering permutations; disconnected components sharing a finding keep exact
companions; mixed missing/blank/ambiguous requirements attach blockers to the correct
rewrites without losing valid X/Y members; duplicate IDs remain ambiguous across severity
and order changes; a connected correctness/intent/performance set retains every member,
with actual correctness leading and category severity not leaking; and DDL/prose/name
similarity cannot create an edge. Every tested physical DDL renders once.

One low-value defect appears: a single rewrite repeating the same valid ID three times in
`requiresIndexes` emits the identical “present in this change set” note three times,
although it correctly renders the DDL once and creates no duplicate graph member.

### q07/global-semantic-risk checkpoint

`reports/round5/m7-q07-global-risk-probe.ts` exits 0. The target q07 neighborhood is
improved: a zero-affinity different-semantics proposal stays below the real high-severity
intent finding as a separate confirmation branch; no semantic-risk input remains a
low-confidence synthetic correctness warning; correctness elsewhere still leads and the
renderer explicitly says the proposal is unattached; and a structurally attached intent
control uses same-issue evidence.

The global fallback is nevertheless over-broad. A high intent finding on an unrelated
relation/column gives an opaque result-changing proposal the same “Intent-confirmation
branch” classification and the statement that an intent finding elsewhere establishes
the population is unsettled. With several unrelated intent risks,
`semanticRiskElsewhere.title` is whichever came first. The report still says the branch is
not automatic, so this is safer than Round 4's false rejection, but it is category leakage:
no exact edge or affinity proves that the unrelated intent issue justifies this branch.

## Executive assessment

Round 5 genuinely closes the Round-4 `BIGGEST_GAP`. Exact, uniquely resolved
`Rewrite.requiresIndexes` edges now form connected components before finding affinity,
and the renderer derives companion prose from actual same-issue membership. The repair is
not limited to builder examples: shared-index orphans, multi-index chains, stars, ordering
permutations, cross-category components, and mixed valid/blocked requirements all retain
the right members without severity ownership. q01's zero-prose-overlap pair still leads as
one action, and the measured-slower index never becomes a standalone first step.

This is now a strong report architecture, but not yet one I would sign. A valid-looking
exact ID with `ddl: 'DROP TABLE generic.things;'` satisfies deployment dependencies and
receives M7-authored prose saying it is a regular `CREATE INDEX` that permits reads. That
is a confident false operational claim at the renderer's runtime boundary. The six known
lower gaps were deliberately left live, and the q07 global fallback also applies intent
framing to unrelated result-changing proposals without relationship evidence.

## Headline findings

### 1. HIGH — arbitrary nonblank payloads are still treated as deployable indexes and receive false safety advice

`missingIndexFields()` (`src/report/prioritize.ts:371-393`) requires only a nonblank
`ddl`; `indexSatisfies()` (`src/report/prioritize.ts:325-327`) repeats that test when
forming an exact dependency edge. The regression probe supplies both
`DROP TABLE generic.things;` and `-- TODO: write DDL`; each yields a clean coupled
rewrite/index action with no dependency blocker.

`lockingNote()` (`src/report/index.ts:125-143`) then authors the statement that the
payload is a regular `CREATE INDEX` which lets reads continue but blocks writes. That is
false for the destructive statement and meaningless for the comment. This is more than a
malformed-input warning omission: M7 upgrades invalid text into a deployable component
and adds confident operational instructions of its own. Fixed means accepting as a
dependency only one complete executable PostgreSQL `CREATE [UNIQUE] INDEX ...` statement
(not merely finding a CREATE prefix before trailing payload), leaving malformed text
visible, blocking the action, and never attaching index-build advice to it.

### 2. MEDIUM — q07's global semantic fallback leaks unrelated intent into an unattached result-changing proposal

The q07 target case is fixed, but `elsewhereMember` (`src/report/prioritize.ts:1056-1062`)
selects any material intent finding anywhere in the report before any correctness finding;
it does not require affinity or an exact relationship. The orphan issue then inherits that
category at line 1076, and `fixBlocks()` (`src/report/index.ts:542-557`) says an intent
finding elsewhere establishes that “the population is unsettled” and calls the proposal
an intent-confirmation branch.

The saved probe changes only the existing finding from q07-like to an unrelated
`unrelated.audit_rows.retention_code` issue. The opaque population-changing rewrite gets
the same intent classification and prose; with several unrelated intent risks, the stored
title is whichever finding appeared first. The branch is still explicitly “not an
automatic repair,” which limits harm, but the relationship is invented. Fixed means the
actual intent finding continues to own `INTENT REQUIRED`, while an unattached rewrite is
labeled as independently requiring confirmation and explicitly not linked; an additive
upstream `addressesFindingIds` edge would be the clean way to prove a true q07 branch.

### 3. MEDIUM — recovered optional validation noise still suppresses proven correctness

`ReportModel` declares `rejectedProblems` and `recoveredProblems`
(`src/report/prioritize.ts:129-134`), but `buildModel()` never returns either
(`src/report/prioritize.ts:1187-1217`). `decideVerdict()` gates on every
`validationProblems` entry at line 1270. Consequently, a safely coerced optional access
path enum or an ignored out-of-range optional cost share changes a fully evidenced
`WRONG RESULTS` analysis into `ANALYSIS INCOMPLETE`.

Truly rejected findings, rewrites, required DDL, and binding failures should keep gating;
the probes confirm they do. Fixed means materializing the advertised split, gating only
on rejected or safety-bearing loss, and listing recoveries under trust limits without
letting an M3 presentation typo outrank a proven result defect.

### 4. MEDIUM-LOW — correctness plus `actionability:'none'` still hides the only remediation

The verdict correctly remains `WRONG RESULTS`, but `issueBlocks()` suppresses remediation
when `lead.actionability === 'none'` (`src/report/index.ts:501-507`). Thus the reader is
told the query is wrong and receives neither “Do this first” nor the supplied manual next
step. `none` means no concrete/automatable change was established; it does not make an
upstream investigation or remediation sentence unsafe to display. Fixed means rendering
it as a non-automated “What to investigate/confirm” note without manufacturing an action.

### 5. Lower — runtime completeness, timing plausibility, and output polish remain open

- `missingAnalysisParts()` validates `missingModules` only when it is already an array
  (`src/report/prioritize.ts:1239-1243`). Runtime values `'M4'` and `[42]` therefore act
  like completeness assertions. This can recreate a clean bill of health when a producer
  intended to declare an absent correctness stage.
- Timing validation is positive-and-finite only (`src/report/prioritize.ts:620-647`). It
  still labels `100 ms -> 1e-10 ms` as a measured `1000000000000.00x speedup`, and accepts
  `Number.MAX_VALUE -> 1 ms`. A plausible measurement contract or explicit bounds are
  needed before such endpoints receive the word “measured.”
- The blocked bottom line opened at `src/report/prioritize.ts:1440` still has one unmatched
  `**`, corrupting the loudest safety line in Markdown and terminal plain output.
- Repeating the same exact ID within one `requiresIndexes` array repeats the identical
  companion note once per occurrence. Graph membership and DDL are correctly deduplicated;
  the prose should be too.

## Preserved gates and senior-quality behavior

- Hard binding errors and all six blank safety fields produce `ANALYSIS INCOMPLETE`;
  warning-only binding does not over-fire. Empty DDL, missing IDs, blank IDs, and duplicate
  IDs block exact dependencies. Recovered optional noise remains the specific over-fire
  described above.
- `Finding.category` and `Finding.actionability` are structural. Scary, imperative, or
  negated prose cannot manufacture correctness, intent, or an action; missing structural
  fields are rejected visibly.
- Adaptive fences contain payload runs of 3/4/6/10 backticks using 4/5/7/11 delimiters.
- q01-like zero-overlap input leads with the coupled pair; shared physical DDL renders
  once. q05/q06-shaped correctness findings lead runtime, and the q07-shaped target case
  remains `INTENT REQUIRED` rather than a synthetic correctness leader.
- q10 remains `NO PERFORMANCE ACTION`, shows the observed bitmap index path, proposes no
  index or performance action, and describes the rewrite as optional same-plan cleanup.
- Valid/absent/empty/blank-only `missingModules` behavior is correct, and the current
  pipeline carries M2–M6 absence inside `Analysis` so all 12 integration reports are
  explicitly partial.
- Three separate processes remain deterministic; ANSI stripping is byte-identical to
  plain output, model/render paths do not mutate caller input, and control bytes are
  escaped.
- A full `shop -> mart` schema rename is structurally and byte-normalized inert. Executable
  renderer source contains no corpus query ID, SQL fingerprint, or anchor phrase. There is
  no special-casing deduction.

## Score rationale

| Axis | Weight | Score | Reasoning |
|---|---:|---:|---|
| Correctness | 40 | 33 | The component model, q01/q05/q06/q07/q10 ordering, evidence provenance, and exact-ID behavior are strong. Deductions remain for false CREATE INDEX advice, implausible “measured” ratios, and unrelated global intent framing. |
| Completeness | 30 | 25 | The Round-4 component loss is closed. Correctness remediation can still disappear, malformed completeness declarations are missed, and the validation split is declared but absent. |
| Clarity | 20 | 18 | The issue-centric document and first screen are excellent on valid inputs. Unmatched safety markup, repeated dependency notes, and global intent metadata cost the remaining points. |
| Calibration | 10 | 8 | q10, ordinary timing comparisons, verification provenance, and ungrounded result changes are well calibrated. Recovered noise over-gates and extreme finite values acquire unjustified measurement authority. |
| **Total** | **100** | **84** | The core Round-5 repair earns a material increase, but a renderer that authors false deployment advice cannot pass senior sign-off. |

## Final verification

- `node --test src/report/report.test.ts` — 39 pass, 0 fail.
- `node eval/dump-report.ts --first15` — all checks pass.
- `node eval/run.ts` — 12/12 compose; M2–M6 declared absent.
- Both new Round-5 probes exit 0 and assert the neighborhoods documented above.
- Round-4 regression and determinism/generalization probes exit 0; the untouched stale
  coupling probe exits at line 168 because it expects the old shared-index defect.
- All report and critic-probe syntax checks pass.
- Final read-only database check: exactly eight `shop` indexes. No database mutation was
  performed.

SCORE: 84
CONVINCED: no
BIGGEST_GAP: In src/report/prioritize.ts and src/report/index.ts, reject non-CREATE IndexRecommendation.ddl before it can satisfy exact-ID dependencies or receive CREATE INDEX operational advice.
GAP_DETAIL: A nonblank `DROP TABLE generic.things;` currently forms a clean coupled component, avoids `ANALYSIS INCOMPLETE`, and receives M7-authored prose claiming it is a regular CREATE INDEX that permits reads. That is confidently wrong and unsafe at the renderer's promised runtime boundary. Fixed means validate one complete executable PostgreSQL CREATE INDEX statement, keep malformed payloads visible as rejected input, block dependent rewrites, and emit no index-build safety prose for them.
