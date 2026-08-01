# Prompt for Codex (or any fresh agent)

Paste everything below the line.

---

Continue building **SQLSage** at `/Users/giofiore/sqlsage`.

**Read `HANDOFF.md` first** — it was rewritten on 2026-08-01 and is authoritative. Then read
`docs/BUILDER-BRIEF.md`, `docs/CRITIC-BRIEF.md`, `reports/round3/m1-critique.md` and
`reports/round3/m7-critique.md`.

**Do not restart or recreate completed groundwork.** The seeded 13.2M-row database, the
12-query corpus, the ground-truth `EXPLAIN ANALYZE` plans, and the frozen blind references
cost real measurement effort.

## The goal

A SQL query explainer and optimizer: given a query and a schema, explain in plain English
what it does and propose optimized, properly-indexed alternatives, at senior
database-performance-engineer level.

**Done means:** every module's critic returns `CONVINCED: yes` with score ≥ 90, and the CLI
and end-to-end pipeline are verified. **Currently zero critics are convinced.**

## Confirm the baseline first

```
node eval/dump-ir.ts --check          -> 406 assertions pass
node --test src/report/report.test.ts -> 35 pass, 0 fail
node eval/dump-report.ts --first15    -> all checks passed
node eval/run.ts                      -> 12/12 compose cleanly
docker exec sqlsage-pg psql -U postgres -d sage -tAc \
  "SELECT count(*) FROM pg_indexes WHERE schemaname='shop'"   -> 8
```

If any of these differ, stop and find out why before doing new work.

## Already fixed — do NOT send builders after these

Four things earlier drafts of this prompt listed as open are **closed and covered**.
Re-opening them wastes a round, and with **no git repository** anywhere in this project a
builder sent to "fix" working code has no baseline to revert to.

1. **M1 comma joins.** `FROM a, b WHERE a.x = b.x` now produces the same `JoinIR` and
   `multipliedRelations` as the explicit-JOIN spelling. Covered at `eval/dump-ir.ts` ~line
   654, including the precision half (an *unequated* comma relation is a genuine cross join
   and gets no invented join).
2. **M7 rewrite/index coupling** — the Round-3 `BIGGEST_GAP`. Fixed 2026-08-01 in
   `src/report/prioritize.ts` ~line 845. **Unreviewed; needs a critic, not a builder.**
3. **M1 correlated LATERAL.** `LATERAL ... ON true` no longer claims the lateral's own
   rows are multiplied when the outer side is unique on the correlation key. Verified
   against the live server by `node reports/round4/probe-lateral.ts` (sums compared, not
   reasoned about). Covered by 7 assertions. **Unreviewed.**
4. **The `Analysis` completeness gap.** `Analysis.missingModules?: string[]` now exists in
   `src/types.ts`, is populated by `src/index.ts`, and blocks categorical verdicts through
   `missingAnalysisParts()`. q06 now renders `ANALYSIS INCOMPLETE` instead of
   `NO ACTION NEEDED`. **Unreviewed.**

Items 2, 3 and 4 are **builder work done by the previous agent**, which had never read any
blind reference. They are labeled unreviewed for exactly that reason.

## Do these, in order

**1. Fresh independent M7 critic → `reports/round4/m7-critique.md`.** The Round-3 gap is
fixed but unreviewed and self-verified, which is precisely what this process distrusts. The
critic may reuse `reports/round1/m7-reference.md`. Probe specifically:
   - whether refusing to couple when a requirement resolves to two findings is right, or
     whether it should pick the highest-severity one
   - a rewrite requiring an index that attached to no finding at all
   - multiple rewrites requiring the same index; one rewrite requiring several
   - that coupling is driven only by `IndexRecommendation.id`, never DDL text or name
     similarity
   - the full Round-3 do-not-regress list in `HANDOFF.md` §1

**2. Fresh independent M1 critic → `reports/round4/m1-critique.md`.** M1 has **no known
open defect**, but it has never been reviewed and its fan-out work was written by hand and
self-verified. **Re-run `probe-fanout.ts`, `probe-leak.ts` and `probe-lateral.ts` after any
change to `computeFanOut`.** Push specifically on the new `lateralCorrelation()` limits:
correlation through an expression, correlation reaching two levels out, a lateral whose
inner block joins several relations, `LEFT JOIN LATERAL`, and a lateral with its own
`GROUP BY` or `LIMIT 1` — all currently fall back to the pessimistic keyless verdict. Full
probe list in `HANDOFF.md` §1.

**3. Finish the M6 blind reference.** `reports/round1/m6-reference.md` is 395 lines covering
**q01–q03 of 12**. **Append, do not restart.** It must be complete *before* any M6
implementation exists, or it is not blind. Brief: `docs/BUILDER-PROMPTS.md` §M6 +
`docs/CRITIC-BRIEF.md` Phase 1.

**4. Only after M1 and M7 have convinced critics**, fan out M2/M3/M4 builders using
`docs/BUILDER-PROMPTS.md`, then their critics against the frozen references. Then M5 and M6
— built independently but cross-checked as a **measured pair**, because q01 proves the
value lives in rewrite/index coupling.

## Process — do not collapse it

For each module: a **fresh builder** subagent implements it; a **separate critic** with
fresh context judges it. The critic writes its own reference from raw SQL, live
`EXPLAIN (ANALYZE, BUFFERS)` and expert sources **before** seeing our output, then diffs,
then inspects the source for corpus special-casing, then scores and names one biggest gap.

Never let one agent both build and judge the same module. If subagents are unavailable and
you do builder work yourself, you may — **but only if you have never read that module's
blind reference** — and you must label the result unreviewed and hand it to an independent
critic. **Preserve that property**: it is the only reason the current unreviewed work is
still reviewable.

## Standing rules

- **Never mark a module complete on builder-green.** Every round so far was green on builder
  tests while a critic found live-proven wrong behavior.
- **Assertion counts are not coverage.** 393 assertions passed while a real bug was live,
  and the M7 coupling test passed for the entire time the coupling bug was live because its
  fixture happened to satisfy the fallback path the bug lived in.
- **When you add a regression test, disable the fix and confirm the test fails.** Copy a
  backup to a scratch directory first — there is no git.
- **Reproduce a critic's headline claim yourself before dispatching a builder.**
- **Send `BIGGEST_GAP` verbatim**, plus a do-not-regress list of what the critic verified as
  good.
- **Whoever writes a builder prompt must not have read that module's blind reference** — the
  answer key leaks by paraphrase.
- **Correctness outranks speed.** q05, q06, q07 return *wrong answers*.
- **q10 is a deliberate false-positive trap** (PG16 already pushes the grouped-key `HAVING`
  predicate down; ~7 ms). Precision is graded as hard as recall — `LIKE 'Customer 1%'` is
  sargable and flagging it is a false positive.
- **Verify against the live PostgreSQL 16.14**, not published advice. PG16 has **no btree
  skip scan** (that is PG 18).
- **The database must always have exactly 8 baseline indexes.** Experiments inside
  `BEGIN; … ROLLBACK;` or via `node eval/verify.ts`. **Never destroy the container** —
  PGDATA is an anonymous volume and `docker commit` does not capture it.
- **Don't run your own timing queries while a critic is measuring** — concurrent load skews
  median-of-3.
- **Keep `progress/state.json` current** (`node progress/serve.mjs` → localhost:5310).
- **A falling score is not automatically a regression** — M1 went 61 → 68 → 60 because a
  deeper gap was finally probed while both earlier defects stayed fixed.
- Node 24.18 runs TypeScript strip-only: explicit `.ts` import extensions, no enums or
  parameter properties. **There is no `tsc` in this project** — `npx tsc` will not work.

## Agent reliability — learned the hard way

Seven subagents were lost in one session: three to account session limits, three to
`Connection closed mid-response`, one to a stall.

- **Instruct every long-running agent to write its output file incrementally.** Proven: one
  M6 attempt reported "all measurements complete … writing the reference" and died losing
  everything; the next was told to write incrementally and **395 measured lines survived**
  the same failure.
- **Tell critics to save probe scripts as they go** under `reports/round<N>/`. The Round-4
  M1 critic died before writing its critique, but its probes survived and found three real
  bugs.
- On a **session-limit** error, wait — retrying burns the same quota. On **connection errors
  or stalls**, retry immediately.
- After any agent death, check for **partial edits** before trusting a file. There is no git
  repo.

## Report honestly

Do not describe SQLSage as complete, working, or end-to-end while any critic is unconvinced.
State plainly which modules are unreviewed, which are rejected, and what is missing. If you
did builder work yourself, say so and say it is unreviewed.

**When you reach ~90% context, stop taking new work and update `HANDOFF.md`** — what is
verified vs. merely written, every measured number with the command that produced it, exact
blockers with file paths, any `src/types.ts` change flagged explicitly, what you did not do
and why, and the precise next action. Update it incrementally rather than all at the end.
