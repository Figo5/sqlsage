# SQLSage — handoff

**Written:** 2026-07-31, mid-round-1, by the previous agent hitting a session limit.
**Read this file top to bottom before touching anything.** Sections marked ⚠️ are
things that will waste your time if you rediscover them the hard way.

---

## 1. What this is

A SQL query explainer and optimizer. Given a query and a schema it must:

1. explain in plain English **what the query does**, and
2. propose **optimized, properly-indexed alternatives**,

at the level of a senior database performance engineer.

The user's process requirement is as important as the product:

> Divide this into the smallest pieces you can improve and judge independently, and
> fan out a builder sub-agent and a separate critic sub-agent with fresh context for
> each piece. The critic should pull real EXPLAIN ANALYZE output and expert-written
> performance breakdowns as ground truth, and blind-compare our output against them
> for correctness, completeness, and clarity — not just whether the query runs. Be a
> harsh critic. Find the biggest remaining gap and send it back for another round.
> Maintain a simple live progress page showing the work evolving. Loop until each
> critic is genuinely convinced our explanations and optimizations match expert
> quality, or I stop the run.

So: **builder agent + separate critic agent per module, fresh context, repeat rounds
until critics sign off.** Do not collapse this into one agent doing both jobs — the
whole point is that the critic has not seen the builder's reasoning.

**Location:** `/Users/giofiore/Downloads/zoo-scavenger-hunt (3) (2)/sqlsage`
(The parent directory is an unrelated SvelteKit "zoo scavenger hunt" project. SQLSage
is self-contained in `sqlsage/` and touches nothing outside it except two additions to
`../.claude/launch.json`.)

---

## 2. Environment

### Database — this is the ground truth, keep it alive

Postgres **16.14** in Docker, container `sqlsage-pg`, **13.2M rows / ~1.6 GB**.

```
host 127.0.0.1   port 55432   db sage   user postgres   password sage   schema shop
```

```bash
docker exec sqlsage-pg psql -U postgres -d sage -c "EXPLAIN (ANALYZE, BUFFERS) SELECT ..."
```

⚠️ **The container has no volume mount — PGDATA lives in an anonymous Docker volume.**
`docker commit` does **not** capture it (I tried; lost the data and had to reseed).
If the container is destroyed, rebuild with:

```bash
docker run -d --name sqlsage-pg --shm-size=2g \
  -e POSTGRES_PASSWORD=sage -e POSTGRES_DB=sage -p 55432:5432 postgres:16 \
  -c shared_buffers=512MB -c work_mem=32MB \
  -c max_parallel_workers_per_gather=2 -c random_page_cost=1.1
# wait for pg_isready, then:
docker exec -i sqlsage-pg psql -U postgres -d sage -v ON_ERROR_STOP=1 < corpus/schema.sql
docker exec -i sqlsage-pg psql -U postgres -d sage -v ON_ERROR_STOP=1 < corpus/seed.sql
node eval/collect-groundtruth.ts
```

⚠️ `--shm-size=2g` is **required**. The default 64 MB makes q06 die with
`could not resize shared memory segment ... No space left on device` during a
parallel hash join. Seeding takes ~2 minutes.

⚠️ Baseline indexes are deliberately minimal: primary keys plus `idx_orders_customer_id`
and `idx_order_items_order_id`. Everything else must be *earned* by the recommender.
Do not add indexes to `corpus/schema.sql` — that would silently invalidate the corpus.

### Runtime

Node **24.18** runs TypeScript directly, no build step: `node src/cli.ts`.
Import with **explicit `.ts` extensions**: `import { x } from '../types.ts'`.

⚠️ **Node is strip-only.** It erases types but cannot transform syntax. These are
banned and will throw at import time:
- **TypeScript parameter properties** — `constructor(readonly sql: string) {}`
- `enum`, `namespace`, `declare` blocks

Use an explicit field + assignment instead:
```ts
class Foo { readonly sql: string; constructor(sql: string) { this.sql = sql; } }
```
**This is currently a live blocker — see §6.**

---

## 3. Architecture — the seven judgeable pieces

`src/types.ts` holds the shared contracts and is the **interface between modules**.
Read it fully; it is the most important file in the repo. Nobody edits it without
flagging the change as a cross-module decision.

| id | module | dir | entry point | status |
|----|--------|-----|-------------|--------|
| M0 | Ground-truth harness | `eval/` | `collect-groundtruth.ts`, `verify.ts` | ✅ done, validated |
| M1 | Schema-bound query IR | `src/ir/` | `bindQuery(sql, catalog): QueryIR` | ⚠️ built, does not import (§6) |
| M2 | Plain-English semantics | `src/explain/` | `explainSemantics(ir): SemanticExplanation` | ❌ not started |
| M3 | Predicted execution | `src/plan/` | `predictExecution(ir, cat): ExecutionAnalysis` | ❌ not started |
| M4 | Anti-patterns/sargability | `src/antipatterns/` | `detectAntiPatterns(ir, cat): Finding[]` | ❌ not started |
| M5 | Index recommender | `src/indexes/` | `recommendIndexes(ir, cat, findings): IndexRecommendation[]` | ❌ not started |
| M6 | Query rewriter | `src/rewrite/` | `proposeRewrites(ir, cat, findings): Rewrite[]` | ❌ not started |
| M7 | Report renderer | `src/report/` | `renderReport(analysis, opts): string` | ✅ imports cleanly, uncritiqued |

Pipeline: `catalog + sql → M1 → {M2, M3, M4} → {M5, M6} → M7`.

**M1 is the load-bearing module.** Everything downstream reads only its IR. A subtle
IR bug becomes five modules confidently wrong in unison. Get M1 right before fanning
out M2–M6; that sequencing was deliberate, not caution.

⚠️ **M5 and M6 are coupled and cannot be fully judged independently** — see §5, q01.
An index without its rewrite can be *worse than nothing*. Have their critics
cross-check each other, or judge the pair on combined measured effect.

---

## 4. Key documents (all already written)

- **`docs/BUILDER-BRIEF.md`** — give this to every builder agent. Environment, quality
  bar, and the one hard rule: **no special-casing the corpus** (no branching on query
  id or SQL text). Critics check for this and it is an automatic fail.
- **`docs/CRITIC-BRIEF.md`** — give this to every critic agent. Contains the blind
  protocol and the scoring rubric. **The phase order is the whole design:**
  1. Critic writes its **own** reference analysis from the raw plan + expert sources,
     saved to `reports/round<N>/<module>-reference.md`, **before reading our output**.
     Anchoring is the failure mode of review; this is what makes it blind.
  2. Only then read our output and diff.
  3. Then read the source hunting for special-casing and fake generality.
  4. Emit the verdict block (`SCORE` / `CONVINCED` / `BIGGEST_GAP` / `GAP_DETAIL`).

  Scoring: correctness 40, completeness 30, clarity 20, calibration 10. 70 = competent
  junior. Deductions: −25 confidently wrong, −15 unchecked folk wisdom, −15 missed
  correctness bug, −10..−40 special-casing. `CONVINCED: yes` requires ≥90, zero
  confident-wrong claims, zero missed correctness bugs, no special-casing.
- **`docs/EXPERT-SOURCES.md`** — curated seed list of authoritative material
  (use-the-index-luke, PG 16 docs, Cybertec, Citus, boringsql, explainextended),
  organized per module, with a standing instruction to verify every claim against
  our actual PG 16.14 because much published advice is stale.

---

## 5. Verified facts — earned with real measurements, do not re-derive

These are measured on the live DB. They are the reference points for judging critics.

### q01 — rewrite and index are coupled (`reports/round1/harness-validation.md`)

| variant | median | plan |
|---|---|---|
| baseline | 108.8 ms | Seq Scan, **650,521 rows removed by filter** per worker |
| + `(status, created_at)` index alone | 113.3 ms | **identical plan — 1.04× SLOWER** |
| half-open range rewrite + `(status, created_at) INCLUDE (customer_id, total_cents)` | **27.6 ms** | **Index Only Scan, 3.94× faster, identical digest** |

The index alone is never used, because `date_trunc('month', o.created_at)` wraps the
column. Recommending the index without the rewrite is a *measurably harmful* answer.
Also verified: `status` belongs **first** in the composite key despite being the
unselective column (85% of rows), because it is the equality predicate and
`created_at` is the range.

### q05 — `NOT IN` on a nullable column is a correctness bug

| form | rows returned |
|---|---|
| `NOT IN (...)` as written | **0** |
| `NOT EXISTS (...)` | **196,000** |

14,285 checkout events have `customer_id IS NULL`; a single one is enough. PG 16
**cannot** convert `NOT IN` to an anti-join when the column is nullable.
(Note: sources claiming PG *19* promotes this are irrelevant — we run 16.)

### q06 — the fan-out silently triples revenue

| | total revenue |
|---|---|
| with the `order_items` join (as written) | 1,280,102,100,000 |
| without it (correct) | 426,700,700,000 |
| **inflation factor** | **exactly 3.0000** |

`sum(o.total_cents)` is multiplied by items-per-order. This is a **wrong-answer bug**,
and the 2.2 s runtime is the secondary story. A module that reports only the slowness
has failed at the job.

### q10 — a deliberate false-positive trap ⚠️

The textbook rule "a non-aggregate filter in HAVING forces you to aggregate
everything, move it to WHERE" is **wrong on PG 16**. The real plan shows the planner
already pushes `customer_id < 1000` down to a **Bitmap Index Scan** (`Index Cond`,
9,990 rows read out of 2M); the query runs in **6 ms**. The correct expert answer is
"this is a readability improvement worth ~0 ms." Any module that promises a speedup
here must be penalized. The pushdown is legal *because `customer_id` is a grouping
key* — that distinction is the real expert insight the folk rule flattens.

I originally wrote this query into the corpus believing the folk rule. The database
corrected me. `corpus/queries.ts` has been updated to describe it accurately as a trap.

### ⚠️ Two seed-data bugs I found and fixed — audit generated data before trusting it

Both were **correlated moduli** silently destroying corpus queries:

1. `customer_id` was NULL when `g % 5 = 0` while `event_type='checkout'` was
   `g % 50 = 0`. Since 50 is a multiple of 5, **every checkout was anonymous**, so
   `NOT EXISTS` returned all 200k customers and q05's demonstration was meaningless.
   Fixed by moving the NULL rule to `g % 7`.
2. `utm_source` used `g % 4` while `event_type` used `g % 10`; they share a factor,
   so `utm_source='email' AND event_type IN ('add_to_cart','checkout')` was an
   **empty set** and q12 returned **zero rows**. Fixed with `(g % 7) % 4`.

Post-fix: q05 → 0 vs 196,000 rows; q12 → 111,589 rows / 20,000 distinct customers.
Lesson for whoever extends the corpus: **check that every query returns a non-trivial
row count**, and keep generator moduli coprime.

---

## 6. ⚠️ Immediate blockers — do these first

### 6a. `src/ir/index.ts` does not import

```
TypeScript parameter property is not supported in strip-only mode
```

Offending lines:
- `src/ir/text.ts:21` — `constructor(readonly sql: string) {}`
- `src/ir/index.ts:93` — `constructor(readonly sql: string, readonly catalog: Catalog)`
- `src/ir/scope.ts:77` — multi-line constructor, check for the same pattern

Fix as shown in §2. Verify with:
```bash
node -e "import('./src/ir/index.ts').then(m=>console.log(Object.keys(m)))"
```
Until this passes, **M1 is unverified and M2–M6 must not be launched.**

### 6b. Ground truth is stale relative to the `events` table

I regenerated `events` twice (§5) **after** the last `node eval/collect-groundtruth.ts`
run. The plans and timings in `groundtruth/` for **q05 and q12** no longer match the
data, and `corpus/catalog.json` has stale `pg_stats` for `events`.

**Re-run before any critic reads ground truth:**
```bash
node eval/collect-groundtruth.ts
```
It rewrites `corpus/catalog.json`, `groundtruth/*.{json,txt}`, and `groundtruth/index.json`.
Takes ~1 minute. The other ten queries are unaffected but re-collecting is cheap and
keeps everything consistent.

### 6c. Two builder agents were still running when the session ended

M1 and M7 agents were mid-flight. Their files are on disk (`src/ir/*`, `src/report/*`)
but **neither wrote its required `NOTES.md`**, so both were incomplete. `src/report/`
imports cleanly and exports `{ buildModel, renderReport }`; `src/ir/` does not import.
Treat both as **unreviewed drafts**. Their agent transcripts are gone — do not try to
resume them, just review what is on disk and fix or rebuild.

---

## 7. Live progress page

Required by the user and currently working. Node static server, no deps:

```bash
node sqlsage/progress/serve.mjs     # serves http://localhost:5310
```
Registered in `../.claude/launch.json` as `sqlsage-progress` (start it with the
preview tool, not with a raw shell command, if your harness has one).

⚠️ `python3 -m http.server` **fails** here — sandbox denies `os.getcwd()` with
`PermissionError`. That is why there is a hand-written Node server.

The page (`progress/index.html`) polls `progress/state.json` every 3 s. It is
light/dark aware and needs no rebuild. **To update the page, just rewrite
`state.json`** — schema: `round`, `status`, `updatedAt`, `subtitle`, `headline`,
`stats[{value,label}]`, `modules[{id,name,builder,critic,score,biggestGap,history}]`,
`events[{t,msg}]`. Status pill values: `pending|running|done|failed`.

Keep it current as work evolves — it is a deliverable, not decoration.

---

## 8. Suggested plan from here

1. **Unblock** — fix §6a, re-run §6b.
2. **Review M1 yourself** against all 12 corpus queries (write `eval/dump-ir.ts` if the
   agent didn't: bind every query, print relations/joins with `fanOut`/predicates with
   `sargable`+reason/binding errors). Check `fanOut` on q06 and q08 especially, and
   sargability verdicts on q01/q02/q09. Fix before fanning out.
   ⚠️ Watch for a real subtlety: `LIKE 'Customer 1%'` (trailing wildcard) **is**
   sargable on btree but needs `text_pattern_ops` under a non-C collation;
   `LIKE '%@example.com'` is not. Precision matters as much as recall.
3. **Fan out M1 + M7 critics** using `docs/CRITIC-BRIEF.md`. Fresh context each.
4. **Fan out builders M2–M6** in parallel once M1 is trusted (5 agents,
   `docs/BUILDER-BRIEF.md` + module-specific prompt).
5. **Fan out 5 critics**, one per module, fresh context.
6. **Aggregate**: record every `SCORE`/`BIGGEST_GAP` into `progress/state.json`
   (`history` array keeps the per-round score trend the page renders).
7. **Round 2**: send each `BIGGEST_GAP` verbatim back to a *fresh* builder for that
   module. Repeat until every critic returns `CONVINCED: yes`, or the user stops it.
8. Wire `src/index.ts` (pipeline) and `src/cli.ts` (`node src/cli.ts <file.sql>`) once
   M2–M6 exist. Neither is written yet.

### Writing good builder/critic prompts

The existing ones worked well. Pattern: point at `docs/BUILDER-BRIEF.md` + `src/types.ts`
+ corpus + groundtruth, state the exact export signature, then spend most of the prompt
on **what "correct" means for this module specifically**, with concrete corpus examples
of the hard cases — and explicitly warn against the false positives (q10, and
`LIKE 'x%'` being fine). End by requiring the agent to verify its own output and write
an honest `NOTES.md` naming its weakest area.

---

## 9. Things that are easy to get wrong

- The user asked for **harsh** criticism. A critic returning 85/100 and vague praise is
  not doing the job. The rubric's deductions exist to be used.
- **Correctness outranks speed, always.** q05, q06, q07 return wrong answers. Any
  report that leads with a speedup on those has misjudged the situation.
- Don't let a module optimize a query it hasn't noticed is already broken.
- Don't trust published SQL advice without running it against **our** PG 16.14.
- Don't add indexes to the baseline schema to make results look better.
- Don't special-case the corpus. It is a test set, not a spec.
