# Ready-to-fire builder prompts — M2 through M6

These are written **from allowed materials only**: `src/types.ts`, `corpus/queries.ts`,
`groundtruth/*`, and measured facts. They deliberately do **not** draw on the frozen
blind references in `reports/round1/m*-reference.md`.

⚠️ **Why that matters.** If whoever writes a builder prompt reads the critic's reference
first, the answer key leaks into the prompt by paraphrase and the blind comparison is
worthless — even with the best intentions. Keep prompt-writing and reference-reading in
separate heads, or at least separate sessions. Builders must never be pointed at their
own reference.

## Preamble to paste into every builder prompt

> Read `docs/BUILDER-BRIEF.md` and `src/types.ts` in full first. Do **not** read
> `reports/round1/<module>-reference.md` — that is the critic's frozen yardstick and
> reading it invalidates the review.
>
> Node 24 strip-only: explicit `.ts` imports, no parameter properties, no enums.
> The live DB is `docker exec sqlsage-pg psql -U postgres -d sage -c "..."`; it must
> still have **exactly 8 indexes** when you finish — experiments go inside
> `BEGIN; ... ROLLBACK;` or through `node eval/verify.ts`.
>
> **No corpus special-casing.** No branch on query id, SQL text, or an input
> fingerprint. The critic greps for it; it is an automatic fail.
>
> Write `src/<module>/NOTES.md` naming, honestly, where you are weakest. Overclaiming
> is punished; accurate self-assessment is rewarded.

## Facts every builder gets (measured, not asserted)

| query | median | fact |
|---|---:|---|
| q01 | 112 ms | `date_trunc()` blocks the index. Index **alone: 1.04x slower, unused**. Rewrite + `(status, created_at) INCLUDE (customer_id, total_cents)`: **3.94x**, index-only scan, identical digest. Rewrites and indexes are **coupled**. |
| q05 | 149 ms | `NOT IN` returns **0** rows; `NOT EXISTS` returns **196,000**. A correctness bug, not a slow query. |
| q06 | 2.4 s | Revenue inflated **exactly 3.0000x** by the `order_items` fan-out. Verified stable under FROM reordering. |
| q07 | 88 ms | WHERE on the outer side demotes the LEFT JOIN. 149,000 rows. Intent defect, not cost. |
| q10 | 7 ms | **Trap.** The textbook "move the non-aggregate filter out of HAVING" rule is *wrong* on PG 16 — the planner already pushes the grouped-key predicate to a Bitmap Index Scan. Correct answer: "clearer, same plan, ~0 ms." |
| q11 | 6.6 s | Correlated subplan loops 2,000,000 times. PG 16 has **no btree skip scan** (that is PG 18). |

Correctness outranks speed everywhere. q05, q06, q07 return wrong answers.

---

## M2 — `explainSemantics(ir, catalog): SemanticExplanation` → `src/explain/`

What the query **means**, never how it runs. If a sentence mentions an index or a scan,
it belongs in M3, not here.

Bar to hit:
- `headline` — one sentence a product manager understands. Not a restatement of the SQL.
- `steps` — the logical narrative, in the order results are conceptually produced. No
  unexplained jargon.
- `resultShape.grain` — "one row per *what*". Getting the grain right on q06 and q08 is
  the whole game: after a fan-out join the grain is one row per **order item**, not per
  order, and that is precisely why `sum(o.total_cents)` triples.
- `caveats` — the traps a reader would otherwise miss. At minimum, and derived from the
  IR rather than pattern-matched: NULL semantics (q05), duplicate multiplication from
  fan-out (q06, q08), a LEFT JOIN demoted by a WHERE clause (q07), timezone/boundary
  behaviour (q01, q09), and ties changing row counts (q11).

Read `QueryIR.blocks[].joins[].fanOut` and its reason — that is M1's job and you consume
it. Do not re-derive it from the SQL text.

Hardest part, and where the critic will push: saying that q06 *over-reports revenue by
about 3x* in plain English, without hedging it into meaninglessness and without claiming
a precise multiplier the catalog cannot support.

## M3 — `predictExecution(ir, catalog): ExecutionAnalysis` → `src/plan/`

Predict how it runs **from the catalog**, then check yourself against `groundtruth/`.

- `accessPaths` / `joinStrategies` with a reason per entry.
- `dominantCosts` is the section that matters. Attribute by **actual time and buffers**,
  not cost units. On q01 the honest answer is "the sequential scan of orders discarding
  650,521 of 666,667 rows per worker".
- `memoryRisks` at `work_mem=32MB`; `estimationRisks` with a direction.
- `scalability` — how it grows. q04's OFFSET is O(depth); q11's correlated subplan loops
  once per row.

⚠️ You are predicting, and you will sometimes be wrong. Say so via confidence rather
than bluffing. A wrong prediction stated flatly is a −25 in review; "likely a hash join,
but a merge join if the input arrives sorted" is fine. **Do not read the ground-truth
plan and pretend you predicted it** — the critic diffs your reasoning, not just your
answer, and will construct queries with no stored plan.

## M4 — `detectAntiPatterns(ir, catalog): Finding[]` → `src/antipatterns/`

Evidence-backed findings only. `Finding` now carries **structured** `category`
(`correctness` | `intent` | `performance`) and `actionability` — M7 must never infer
these from prose, so set them correctly.

- `category: 'correctness'` for q05 and q06. `'intent'` for q07.
- Every finding carries `evidence.sqlFragment`. No evidence, no finding.
- `impact` cites catalog numbers: "`status = 'complete'` matches 85% of 2,000,000 rows".
- `caveat` states when the finding would **not** apply.

⚠️ **Precision is graded as hard as recall.** q10 must produce **no performance
finding** — it is the false-positive trap. `LIKE 'Customer 1%'` (trailing wildcard) is
sargable; flagging it is a false positive, and `text_pattern_ops` under a non-C
collation is a *caveat*, not a disqualification. Five modules read your output; a false
positive propagates further than a miss.

## M5 — `recommendIndexes(ir, catalog, findings): IndexRecommendation[]` → `src/indexes/`

- Column order justified in `columnOrderRationale`. The rule is equality first, then the
  range — q01 proves `(status, created_at)` is right **despite** status matching 85%,
  because it is the equality predicate.
- `INCLUDE` is payload only: it cannot narrow a scan or satisfy an `ORDER BY`.
- Partial and expression indexes where they win. ⚠️ `timestamptz::date` is **not
  immutable** and cannot be used in an expression index without pinning a timezone (q09).
- `cost` must state write amplification honestly. An index that wins 1.05x does not earn
  its maintenance.
- Stable `id`, because `Rewrite.requiresIndexes` references it exactly.

⚠️ **Never recommend an index that only pays off after a rewrite without saying so.**
q01's index alone is a measured regression. Verify every candidate with
`node eval/verify.ts index <id> "<DDL>"`.

## M6 — `proposeRewrites(ir, catalog, findings): Rewrite[]` → `src/rewrite/`

⚠️ Its blind reference is `reports/round1/m6-reference.md` — **do not read it.**

- `equivalence` is the field that gets you rejected. `exact` only when provable.
  q05/q06/q07 rewrites are `different-semantics` **because the original is wrong** — say
  that plainly rather than calling it a speedup.
- q04 keyset pagination needs the **row-value** form `(created_at, order_id) < (?, ?)`,
  a matching composite index with matching direction, and it **cannot jump to an
  arbitrary page** — a product constraint, not a code change.
- q11: `DISTINCT ON` and `row_number()` differ under ties. Check whether ties exist in
  this data before claiming equivalence.
- `requiresIndexes` must reference real M5 ids. M5/M6 are judged as a **measured pair**.

Verify every rewrite with `node eval/verify.ts rewrite <id> "<SQL>"` and report the
digest comparison. A rewrite whose digest differs is either a correctness repair you can
justify, or a bug — never shrug at it.
