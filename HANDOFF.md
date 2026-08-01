# SQLSage — CLI-first product handoff

**Updated:** 2026-08-01 by Codex. The active roadmap is
[`docs/CLI-FIRST-PLAN.md`](docs/CLI-FIRST-PLAN.md).

**Route change:** the microscopic builder/critic loop and the requirement that every
module reach `CONVINCED: yes` are superseded. Preserve the verified regressions and live
database evidence below, but do not resume that loop. Work now advances through
user-visible CLI milestones: installable command, complete offline M2–M6 analysis, saved
plans/schema SQL, safe connected PostgreSQL, then packaging and one bounded product review.

Current product truth:

- M1–M7 are implemented and wired by default. The test suite currently has 141 passing
  tests plus one opt-in live integration test; M1's separate adversarial harness retains
  406 assertions.
- `sqlsage analyze` accepts files, inline SQL, stdin, catalog JSON, supported PostgreSQL
  schema SQL, saved JSON plans/evidence bundles, and a live database URL. Text, Markdown,
  and reusable JSON output have stable exit behavior and clean diagnostics.
- Live mode is non-executing by default. Explicit `--analyze` is parsed as one read-only
  statement, schema-bound after introspection, run in a timed read-only transaction, and
  rolled back. Candidate rewrites and DDL are never executed.
- The npm tarball contains built JavaScript, catalog/demo data, README, and the product
  contract—six files total. A fresh-prefix install smoke runs the packaged binary and a
  complete q10 analysis successfully.
- All twelve corpus workflows pass the CLI-first acceptance harness, including q01,
  q05, q06, q07, and q10. Schema import produces six tables/eight indexes; saved-plan
  output is evidence-labeled and reusable.
- Round 8's renderer score remains historical evidence, not a release protocol. Its
  safety regressions remain in the product suite.
- The one bounded product review is complete. It found three release blockers—false
  completeness for non-SELECT input, a missing `--analyze` side-effect warning in help,
  and uncaught `EPIPE` output failure. All three are fixed with process-level regressions,
  and the complete release verification passed afterward.
- PostgreSQL must retain exactly eight persistent `shop` indexes.

**Next action:** there is no required build step for the CLI-first objective. The current
0.1.0 package is release-ready for local/tarball installation. A future owner may decide
whether to remove `private: true` and publish to a registry; that is a distribution choice,
not an unfinished product workflow. Do not restart the historical critic loop.

---

## Historical baseline before the CLI-first pivot

Verified by running the commands, not from memory:

```
node eval/dump-ir.ts --check          -> 406 assertions pass
node --test src/report/report.test.ts -> 48 pass, 0 fail (Round-8 artifact; critic now active)
node eval/dump-report.ts --first15    -> all checks passed
node eval/run.ts                      -> 12/12 compose cleanly
node reports/round4/probe-fanout.ts   -> runs clean
node reports/round4/probe-leak.ts     -> runs clean
node reports/round4/probe-lateral.ts  -> all lateral checks passed (live server)
pg_indexes where schemaname='shop'    -> 8   (correct baseline)
```

| module | state | trust |
|---|---|---|
| M0 harness | complete, re-audited | verified |
| M1 IR | 406 assertions green; **no known open defect** | ⚠️ unreviewed, author-conflicted |
| M2–M5 | blind references frozen and complete; **no builders** | references verified |
| M6 rewriter | blind reference **3 of 12 queries written** (q01–q03) | partial |
| M7 renderer | Round-8 bare-CR repair complete; 48 tests green | boundary accepted; remaining findings are prioritized product backlog |
| pipeline/CLI | `src/index.ts`, `src/cli.ts`, `eval/run.ts` wired, 12/12 | integration only |

### Codex continuation checkpoint — 2026-08-01

Codex resumed from this rewritten handoff and re-ran the baseline before any new work:

```text
node eval/dump-ir.ts --check          -> 406 assertions pass
node --test src/report/report.test.ts -> 35 pass, 0 fail
node eval/dump-report.ts --first15    -> all checks passed
node eval/run.ts                      -> 12/12 compose cleanly
pg_indexes where schemaname='shop'    -> 8
```

A fresh, independent Round-4 M7 critic adopted the frozen Round-1 reference before
inspecting current output and completed `reports/round4/m7-critique.md`: **78/100,
CONVINCED: no**. The narrow q01 repair works, but exact-ID dependencies are not yet
first-class change sets: shared-index and multi-index bundles split while the renderer
falsely claims adjacency, and q07-like orphan intent rewrites can still become synthetic
correctness leaders. Codex independently reran all three saved probes and reproduced the
headline before dispatching a fresh, reference-blind Round-5 builder. That builder has
completed first-class exact-ID components and q07-safe intent branches, with 39/39 tests
and load-bearing disabled-fix proof. Codex independently reverified the finished artifact.
The Round-5 critic then accepted the component repair across chains, stars, order
permutations, mixed blockers, and cross-category components, but scored **84/no** because
arbitrary nonblank payloads such as `DROP TABLE` can still satisfy index dependencies and
receive false M7-authored `CREATE INDEX` locking advice. Codex reproduced that unsafe
boundary and dispatched a fresh reference-blind Round-6 builder for DDL validation only.
That builder completed a shared lexer-backed recognizer used by validation, dependency
formation, and defensive rendering, with 43/43 tests and three load-bearing mutant proofs.
The Round-6 critic accepted those defenses but live PostgreSQL 16 differential probes
found grammar-soundness failures in normalized-away clauses that still reach deployable
rendering and advice. Its final synthesis was completed by a verdict-only adjudicator after
an automated filter blocked the original critic's final message: **39/no** after the
mandatory confident-wrong deduction. Codex reran both probes and reproduced the headline
before dispatching a fresh reference-blind Round-7 grammar builder. That builder completed
exact supported storage syntax, PostgreSQL identifier keyword rules, empty-quantifier
rejection, and conservative Unicode/escape-form rejection, with 46/46 tests and four
load-bearing grammar mutants. Codex root-verified the finished artifact and dispatched a
new independent critic. Its 100-case live PostgreSQL 16 matrix accepted all eight prior
grammar repairs but found one statement-boundary false accept: PostgreSQL ends a `--`
comment on a bare carriage return while SQLSage's lexer searched only for `\n`, hiding a
following executable statement as comment content. The end-to-end probe proved that this
payload satisfied an exact-ID rewrite dependency, rendered as a coupled action, and
received ordinary `CREATE INDEX` lock guidance. The adjudicated verdict is **50/no** after
the mandatory confident-wrong deduction. Codex independently reran both saved Round-7
probes, reproduced the differential and rendering failures, and confirmed eight indexes
before dispatching a fresh reference-blind Round-8 builder for this boundary only. That
builder completed a shared LF/CRLF/bare-CR line-comment repair with 48/48 tests and
load-bearing disabled-fix proof. Codex independently verified the full baseline, saved
non-regression probes, and the 100-case live-PG matrix now reporting zero false accepts.
A fresh independent Round-8 critic completed the whole-module review at **51/no**. Its
44-case live PostgreSQL line-boundary matrix and 18-case model/renderer matrix accepted
the CR repair; the database finished with exactly eight indexes. Its remaining findings
are preserved in `reports/round8/m7-critique.md` and are release blockers only when they
cause unsafe advice, false completeness, crashes, or unusable CLI behavior.

### What changed on 2026-08-01 (this session)

Three things were fixed. **All are builder work done by me and are UNREVIEWED.** I am
eligible under the protocol: **I have never opened any module's blind reference**, so an
independent critic can still judge this. Whoever continues must preserve that property.

**1. M7 Round-3 `BIGGEST_GAP` — CLOSED (unreviewed).**
`src/report/prioritize.ts`. A rewrite and the index it declares in `requiresIndexes` are
one deployable change, but the coupling repair only ran in one direction: it iterated
`rwAssign`, so it could pull an index to a rewrite, never a rewrite to an index. Indexes
attach structurally (relation + column); rewrites attached only by **prose overlap**. On
q01 the rewrite's wording did not echo the finding, so it orphaned into a step of its own
and "create the index" became step 1 — and **that index alone measures 113.3 ms against a
108.8 ms baseline, 1.04x slower and never used.** Only the pair is worth 3.94x.

Fixed with a reverse pass (`src/report/prioritize.ts` ~line 845): an unassigned rewrite is
pulled to whatever finding its required index landed on, but **only when the requirement
resolves to exactly one finding** — two would be a guess. Matching is exact contract
identity through the existing `indexSatisfies` (`id` equality plus non-empty `ddl`), never
DDL text or name similarity.

Before → after on `reports/round3/q01.ts`:

```
before: 2 issues, 104 lines
  §1 "date_trunc() ... unindexable"      rw=[]                      idx=[idx_orders_status_created_at_incl]
  §2 "Filter the raw created_at column"  rw=[half-open-month-range] idx=[]
after:  1 issue, 99 lines
  §1 "date_trunc() ... unindexable"      rw=[half-open-month-range] idx=[idx_orders_status_created_at_incl]

## Do this first
1. **Filter the raw created_at column with a half-open range and create
   `idx_orders_status_created_at_incl`** — ... *(coupled rewrite + index · conditionally equivalent)*
```

⚠️ **The pre-existing test `'a rewrite stays in the same issue as the index it explicitly
requires'` passed for the entire time this bug was live** — its fixture rewrite echoes the
finding's wording, so fuzzy affinity attached it and the declared edge was never exercised.
Two new tests strip that prose overlap. **Both were confirmed to fail without the fix**
(33/34) and pass with it (34/34) — verified by temporarily disabling the fix from a backup
copy, then restoring and re-verifying the file was clean.

**2. `Analysis` contract gap — CLOSED (unreviewed).**
With M2–M6 absent, q06 — which over-reports revenue by exactly 3.0000x — rendered as
`NO ACTION NEEDED ... in the complete analysis`. A module that never ran contributes no
findings, which is byte-identical to a module that ran and found nothing; only the producer
knows which.

- `src/types.ts` — added `Analysis.missingModules?: string[]` (optional, backward
  compatible). **This is a shared-contract change, flagged not silent.**
- `src/index.ts` — the pipeline now writes it *into* the `Analysis`, not just alongside it,
  so a renderer handed only the `Analysis` still knows. `PipelineResult.missingModules`
  stays for existing callers.
- `src/report/prioritize.ts` — `missingAnalysisParts()` folds it in, so it blocks a
  categorical verdict through the machinery that already existed. Blank/empty lists are an
  assertion of completeness and do **not** trigger it.

Isolated proof on q06:

```
WITH declared missingModules  -> ANALYSIS INCOMPLETE
WITHOUT (old behaviour)       -> NO ACTION NEEDED
```

The `src/cli.ts` banner is now a courtesy on top of a real mechanism, not the mechanism.

### 🔴 HAZARD (resolved) — `prioritize.ts` partial edits from a dead agent

**Resolved 2026-08-01. Do not re-investigate.** A Round-4 builder wrote ~750 bytes to
`src/report/prioritize.ts` and died; with no git repo there was no diff baseline. I
inspected it: **no orphaned or incomplete fragments** — all 72 top-level declarations
resolve (the only two flagged unused, `buildModel` and `fmtPct`, are exported and consumed
by `src/report/index.ts`), no TODO/WIP markers, the file parses, renders deterministically
across processes, and its tests pass. The dead builder's edits shifted line numbers (the
Round-3 critique's `rewriteAffinity` at 291-305 was found at 308-322) but **fixed nothing**.
There was nothing to remove. The file has since been fixed properly — see item 1 above.

### ✅ M1 LATERAL false positive — FIXED 2026-08-01 (unreviewed)

Was: `LATERAL ... ON true` reported `multiplied=[c,t]` where `sum(t.total_cents)` is
correct. A correlated LATERAL spells its join condition **inside its own block**, so the
outer `ON` reads `ON true` and only *looks* keyless.

`lateralCorrelation()` (`src/ir/index.ts`, beside `proveLeftUnique`) recovers the keys: an
equality inside the derived block between one of that block's relations and a relation
written to its **left**. Only a lateral can produce one — a plain derived table is bound
against the enclosing scope and cannot see those aliases at all, so a *resolved* reference
to one is itself the proof of correlation. Nothing sniffs for the `LATERAL` keyword. The
verdict then mirrors the equivalent plain join; full table in `src/ir/NOTES.md`.

```
correlated LATERAL : side=left multiplied=[c]   <- was side=both multiplied=[c,t]
plain-join control : side=left multiplied=[c]   <- identical, as it must be
```

**Verified against the live server, not reasoned about** —
`node reports/round4/probe-lateral.ts` sums the lateral's own column over the join and
compares it to the true sum:

| case | shape | server | IR claims `t` multiplied | agrees |
|---|---|---|---|---|
| A | outer unique on key | **exact** | no | ✅ |
| B | inner unique, outer not | **INFLATED 10.0000x** | yes | ✅ |
| C | neither unique | **INFLATED 10.0000x** | yes | ✅ |
| D | uncorrelated lateral | — | yes (pessimistic, correct) | ✅ |

Case B is new capability, not just a repair: the mirror-image lateral fan-out, where the
lateral yields one row per outer row but the outer side is not unique, so each lateral row
*is* re-derived. **7 assertions added (406 total)**, and they were confirmed to fail
against a reverted copy of `src/ir/index.ts` before being accepted. A negated correlation
(`<>`) is explicitly not accepted as a key.

**Known limits, and the obvious places for a critic to push:** a correlation through an
expression (`= c.customer_id + 0`), a correlation reaching two levels out, or a lateral
whose inner block joins several relations all fall back to the pessimistic keyless
verdict — noisier, not wrong.

⚠️ **The comma-join defect is FIXED and COVERED — do not send a builder after it.**
`FROM a, b WHERE a.x = b.x` now produces the same `JoinIR` and the same
`multipliedRelations` as the explicit-JOIN spelling, verified by direct probe. Coverage is
at `eval/dump-ir.ts` ~line 654 and includes the precision half: an *unequated* comma
relation is a genuine cross join and is not given an invented join.

### 🔴 OPEN — M1's fan-out work is unreviewed by a conflicted author

Written by hand when subagents were unavailable, then self-verified. A critic's salvaged
probes found three defects the 393 assertions missed; two are fixed, one (LATERAL) is open.
**Treat M1 as unreviewed work by a conflicted author.**

⚠️ **Assertion counts are not coverage.** 393 assertions passed while a real bug was live,
and the count stayed at 399 across a change that genuinely added coverage, because the new
assertions replaced earlier scaffolding. The number moves for reasons unrelated to quality
in both directions.

---

## Historical critic-loop sequence — superseded; do not execute

**A. M7 builder/critic loop — fresh Round-8 critic currently running.**
Round-7 critique is complete at `reports/round7/m7-critique.md`: **50/no**. It accepted
all eight saved Round-6 grammar repairs but proved against live PostgreSQL 16 that a bare
carriage return ends a `--` comment while `src/report/index-ddl.ts` treats everything after
the comment as hidden unless it sees `\n`. The saved differential probe has exactly one
false accept; the saved end-to-end probe shows the following statement satisfying a
rewrite dependency and receiving false deployable lock guidance. Codex reran both probes
and reproduced the headline before dispatching a fresh reference-blind Round-8 builder.
That builder changed only `src/report/index-ddl.ts`, `src/report/report.test.ts`, and
`src/report/NOTES.md`; its LF/CRLF/bare-CR boundary repair is root-verified at 48/48, and
the saved 100-case live-PG matrix now reports `falseAccepts=0` before stopping at its stale
assertion that expected the defect. A separate fresh critic is reviewing now; do not
self-approve. Earlier component probes included:

- whether the one-target restriction is right — should a requirement resolving to two
  findings couple to the highest-severity one, or is refusing correct?
- a rewrite requiring an index that attached to **no** finding at all
- multiple rewrites requiring the same index, and one rewrite requiring several
- that the new coupling cannot be driven by DDL text or name similarity, only by `id`
- the full Round-3 do-not-regress list below

**B. Fresh independent M1 critic → `reports/round4/m1-critique.md`.** M1 has no *known*
open defect, but it has never been reviewed and its fan-out work was written by hand and
self-verified. It may reuse `reports/round1/m1-reference.md`. Tell it to probe:

- the noisiness trade-off — is `fanOut=true` on q01's `orders→customers` defensible, or has
  precision been traded away too cheaply?
- the new `lateralCorrelation()` limits: correlation through an expression, correlation
  reaching two levels out, a lateral whose inner block joins several relations, `LEFT JOIN
  LATERAL`, and a lateral with its own `GROUP BY` or `LIMIT 1`
- derived-table shapes where `proveLeftUnique` falls back to "not provable"
- whether `multipliedRelations` is right for `FULL`/`RIGHT` joins (never tested)
- 4+ relation chains and self-joins
- that the q08 assertion change is justified by the server, not convenient

**C. Finish the M6 blind reference** — `reports/round1/m6-reference.md`, 395 lines covering
**q01, q02, q03 only**. **Append, do not restart.** It must be complete *before* any M6
implementation exists or it is not blind. Brief: `docs/BUILDER-PROMPTS.md` §M6 +
`docs/CRITIC-BRIEF.md` Phase 1.

**D. Only after M1 and M7 have convinced critics**, fan out M2/M3/M4 builders using
`docs/BUILDER-PROMPTS.md`, then their critics against the frozen references. Then M5 and
M6 — built independently but cross-checked as a **measured pair**, because q01 proves
rewrite/index coupling is where the real value is.

**E. Re-verify end to end** and confirm the database returns to exactly eight indexes.

### Round-3 do-not-regress lists

**M7 — critic verified these genuinely good:** all four Round-2 gates (hard binding errors,
six blank-field variants, empty-DDL and missing-ID dependencies → `ANALYSIS INCOMPLETE`)
without over-firing; `Finding.actionability` structural with the prose regex gone; adaptive
Markdown fences at 3/4/6/10 backticks; q10 → `NO ACTION NEEDED` in 55 lines; determinism
across processes; ANSI-stripped terminal byte-identical. **No special-casing — the critic
proved the one `'shop'` literal inert by renaming the schema throughout.**

**M1 — critic verified these genuinely good:** `USING` namespace resolution (star expansion
matches PG's own `information_schema` output); three-valued-logic null-rejection (10/10
against the live server, including the `IS FALSE` demotion and correctly *not* flagging the
`IS NULL` anti-join idiom); balanced Boolean fragments with byte-identical JSON round-trip;
a 22-case sargability battery with no false positives **or** negatives; q10's trap avoided.
No special-casing.

---

## Active product and required process

Given a SQL query plus schema/catalog data, SQLSage must (1) explain what the query means
in plain English and (2) propose optimized, properly indexed alternatives at senior
database-performance-engineer quality.

**Done now means** the installable CLI satisfies the definition of done in
`docs/CLI-FIRST-PLAN.md`: complete meaningful M2–M6 output, offline and safely connected
workflows, the named 12-query gates, deterministic text/Markdown/JSON, smoke and
integration tests, five-minute README, eight persistent indexes, and an honest backlog.

Focused implementation agents and a bounded milestone review are useful. Endless
single-defect loops are not. Immediately fix wrong-result advice, unsafe SQL/DDL, false
completeness, fabricated measurements, crashes, or broken primary workflows. Record
lower-risk formatting and conservative false rejections without blocking the product.

---

## §3 — runtime and database ground truth

### Node

Node 24.18 runs TypeScript directly in strip-only mode (`node src/ir/index.ts`). Imports
use explicit `.ts` extensions. Parameter properties, enums, and other transform-requiring
syntax are not allowed. There is **no `tsc` in this project** — `npx tsc` will not work.

### PostgreSQL

```text
container  sqlsage-pg      version  PostgreSQL 16.14
host       127.0.0.1       port     55432
database   sage            user     postgres      password  sage      schema  shop
```

13,250,200 rows: categories 200, products 50,000, customers 200,000, orders 2,000,000,
events 5,000,000, order_items 6,000,000.

Exactly **eight** baseline indexes: six primary keys plus `idx_orders_customer_id` and
`idx_order_items_order_id`. Check before and after index work:

```bash
docker exec sqlsage-pg psql -U postgres -d sage -c \
  "SELECT tablename,indexname FROM pg_indexes WHERE schemaname='shop' ORDER BY 1,2"
```

Run experiments inside `BEGIN; … ROLLBACK;` or via `node eval/verify.ts`.
**Never destroy the container** — PGDATA is an anonymous Docker volume and `docker commit`
does not capture it. Rebuild instructions, including the required 2 GB shared memory
setting, are in `docs/HANDOFF-CLAUDE-INITIAL.md`.

### Ground-truth artifacts

`groundtruth/` holds a clean final collection for all 12 queries: real
`EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)`, median-of-three timings, complete-result
row counts and multiset digests, and a catalog whose PK/FK fields are real string arrays.

| query | median | rows | key fact |
|---|---:|---:|---|
| q01 | ~112 ms | 5 | function-wrapped date forces full orders scan |
| q05 | ~149 ms | 0 | nullable `NOT IN` is wrong; `NOT EXISTS` returns 196,000 |
| q06 | ~2.4 s | 100 (LIMIT) | revenue is exactly 3.0000x too high |
| q07 | ~88 ms | 149,000 | right-side WHERE demotes the LEFT JOIN semantically |
| q10 | ~7 ms | 999 | PG16 already pushes the grouped-key HAVING predicate |
| q11 | ~6.6 s | 200,000 | correlated subplan loops 2,000,000 times |
| q12 | ~196 ms | 1 | aggregate consumes 111,589 qualifying event rows |

The verified q01 paired experiment is authoritative: index alone **1.04x slower and
unused**; half-open rewrite plus `(status, created_at) INCLUDE (customer_id, total_cents)`
**3.94x faster**, index-only scan, identical result digest.

Two stale beliefs were removed from the corpus/docs: equality-first `(status, created_at)`
is correct despite status matching 85%; and **PostgreSQL 16 has no btree skip scan** (that
is PG 18).

M5's 704-line reference highlights: q04 as-written + covering index ~3x, keyset + index
~3,694x for the tested cursor; q05 correctness rewrite + partial index ~147 ms wrong/0 rows
→ ~45 ms correct/196k; q08 candidate pair ~3.34x; q09 half-open rewrite + BRIN ~5.56x with
a ~40 kB index; q11 `DISTINCT ON` + index ~24x while still scanning all 2M entries on PG16;
q12 partial expression btree ~3.13x, generic payload GIN unused.

---

## §4 — shared contract (`src/types.ts`)

Additive changes made across this project, all deliberate. Future builders must use these
structured fields — **do not reintroduce prose inference**:

- `ResolvedColumnRef.nullable` and `nullabilityReason`
- serializable `subqueryBlockIds` on predicates and projections
- lossless `QueryBlockIR.groupByExpressions`
- `Finding.category = correctness | intent | performance`
- `Finding.actionability = required | optional | none`
- stable `IndexRecommendation.id`; `Rewrite.requiresIndexes` references those exact IDs
- `JoinIR.fanOutSide: 'left' | 'right' | 'both' | 'none'` and
  `JoinIR.multipliedRelations: string[]`
- **`Analysis.missingModules?: string[]`** (2026-08-01)

⚠️ **`JoinIR.fanOut` now means "multiplies *either* input" and is noisier by design.** A
plain lookup onto a primary key reports `true`/`side='right'` whenever the left input is
not unique (q01's `orders→customers` is such a case). That is correct — those right rows
genuinely repeat — but **downstream must key off `multipliedRelations` ∩ aggregate sources,
not the bare boolean**, or it will produce false positives. Full detail in
`src/ir/NOTES.md` under "Round 4".

---

## §5 — score history

| id | module | status | scores |
|---|---|---|---|
| M0 | ground-truth harness | complete, re-audited | n/a |
| M1 | schema-bound IR | no known open defect, **unreviewed** | 61 → 68 → **60** |
| M2 | semantic explanation | blind reference frozen; no builder | none |
| M3 | execution prediction | blind reference frozen; no builder | none |
| M4 | anti-pattern findings | blind reference frozen; no builder | none |
| M5 | index recommendations | blind reference frozen; no builder | none |
| M6 | query rewrites | reference 3/12; no builder | none |
| M7 | report renderer | R8 repair root-verified; independent critic running | 46 → 87 → 75 → 78 → 84 → 39 → **50** |

⚠️ **M1's 68 → 60 is not a regression.** Both Round-2 defects were verified genuinely fixed
and more broadly than before. The lower score reflects a deeper structural gap earlier
rounds never probed. Do not "restore" the old score by reverting anything. **A falling
score is the process working.**

Critiques and their reproducible probes: `reports/round1/`, `reports/round2/`,
`reports/round3/` (`m1-critique.md`, `m7-critique.md`, `q01.ts`, `adv-m7.ts`,
`probe1–6.ts`), `reports/round4/` (`probe-fanout.ts`, `probe-leak.ts`).

---

## §6 — protocol lessons worth keeping

1. **Reproduce a critic's headline claim yourself before dispatching a builder.** Cheap,
   and a builder sent chasing a phantom wastes a whole round. With no git repo, a builder
   sent to "fix" already-working code has no baseline to revert to.
2. **Send `BIGGEST_GAP` verbatim, plus an explicit do-not-regress list.** Naming what the
   critic verified as good is what stops a fix costing more than it buys.
3. **Whoever writes a builder prompt must not have read that module's blind reference.**
   The answer key leaks by paraphrase.
4. **A passing test suite can be structurally blind.** The M7 coupling test passed
   throughout because its fixture happened to satisfy the fallback path the bug lived in.
   When adding a regression test, **disable the fix and confirm the test fails.**
5. **Wire an integration path early, even when most modules are stubs.** The `Analysis`
   contract gap was invisible to every module-level test and surfaced on the first
   end-to-end run. It costs little and it is the only thing that finds contract gaps.
6. **Don't run your own timing queries while critics are measuring** — concurrent load
   skews median-of-3 and corrupts the evidence you need to judge them.
7. **Correctness outranks speed.** q05, q06, q07 return *wrong answers*.
8. **q10 is a deliberate false-positive trap.** PG16 already pushes the grouped-key
   `HAVING` predicate down (~7 ms), and `LIKE 'Customer 1%'` is sargable — flagging it is a
   false positive. Precision is graded as hard as recall.
9. **Verify against the live PostgreSQL 16.14, not published advice.**

---

## §7 — agent reliability, learned the hard way

Seven subagents were lost in one session: three to account session limits, three to
`Connection closed mid-response`, one to a 600 s stall. **Assume any agent may die at any
moment.**

- **Instruct every long-running agent to write its output file incrementally.** Proven: one
  M6 attempt reported "all measurements complete … writing the reference" and died losing
  everything; the next was told to write incrementally and **395 measured lines survived**
  the same failure.
- **Tell critics to save probe scripts as they go** under `reports/round<N>/`. The Round-4
  M1 critic died before writing its critique, but its probes survived and found three real
  bugs.
- On a **session-limit** error, wait — retrying burns the same quota. On **connection
  errors or stalls**, retry immediately.
- **After any agent death, check for partial edits before trusting a file.** There is no
  git repository anywhere in this project, so there is no diff baseline and no clean
  revert. Preserve files carefully. When editing risky files, copy a backup to a scratch
  directory first.

---

## §8 — progress page

```bash
node progress/serve.mjs      # http://localhost:5310
```

Standalone launcher: `.claude/launch.json`. The page polls `progress/state.json` every
three seconds. Keep `progress/state.json` current, including score history and biggest gaps.

---

## §9 — files worth reading first

```text
HANDOFF.md                     this file
docs/CODEX-PROMPT.md           ready-to-paste prompt for the next agent
docs/BUILDER-BRIEF.md          builder rules
docs/BUILDER-PROMPTS.md        ready-to-fire M2-M6 builder prompts (reference-blind)
docs/CRITIC-BRIEF.md           blind protocol and rubric
docs/EXPERT-SOURCES.md         primary/expert source map
reports/round3/m1-critique.md  latest M1 verdict (60, rejected)
reports/round7/m7-critique.md  latest M7 verdict (50, rejected — R8 builder active)
src/types.ts                   shared contracts
src/ir/NOTES.md                current M1 approach and limits
src/report/NOTES.md            current M7 approach and limits
corpus/queries.ts              12-query judgment corpus
groundtruth/index.json         final timing/count/digest summary
reports/round1/m5-reference.md measured blind index yardstick
```

The database, the ground truth, and the frozen references cost real measurement effort —
**do not restart or recreate them.** They are now implementation/test evidence, not a
reason to delay the vertical slice.

## §10 — reporting honestly

Do not describe SQLSage as a usable product until the documented CLI workflow and complete
M2–M6 analysis actually work. State which user workflows work, which still fail, whether
claims are predicted/observed/measured, and what remains in the release backlog.

**When you reach ~90% context, stop taking new work and update this file** — what is
verified vs. merely written, every measured number with the command that produced it, exact
blockers with file paths, any `src/types.ts` change flagged explicitly, what you did not do
and why, and the precise next action. Update it incrementally rather than all at the end.
