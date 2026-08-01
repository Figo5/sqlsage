# SQLSage — goal prompt

Paste the block below to resume work in a fresh session. It is written to be
self-contained: it assumes the reader knows nothing except the project path.

---

Continue building SQLSage at `/Users/giofiore/sqlsage`.

**Read `HANDOFF.md` completely first** — start at the `§5-R4` banner, which is the
current truth; `§5` is stale. Then read `docs/BUILDER-BRIEF.md`, `docs/CRITIC-BRIEF.md`,
and the latest critiques in `reports/round3/` and `reports/round4/`. Treat the handoff as
authoritative. **Do not restart or recreate completed groundwork** — the seeded database,
the 12-query corpus, the ground-truth plans, and the frozen blind references took real
measurement effort to produce.

## The goal

A SQL query explainer and optimizer: given a query and a schema, explain in plain English
what it does and propose optimized, properly-indexed alternatives, at the level of a
senior database performance engineer.

It is finished when **every module's critic returns `CONVINCED: yes` with score ≥ 90**,
and the CLI and end-to-end pipeline are wired and verified. Not before.

## The process — do not collapse it

Work is split into small independently-judgeable modules (M1–M7). For each:

1. A **fresh builder** subagent implements or fixes it.
2. A **separate critic** subagent, with fresh context, judges it.

The critic writes its **own reference** from the raw SQL, live `EXPLAIN (ANALYZE, BUFFERS)`
and expert sources **before** looking at our output, then diffs, then inspects the source
for corpus special-casing, then scores and names the single biggest gap.

**Never let one agent both build and judge the same module.** If subagents are
unavailable and you do builder work yourself, you may — but only if you have never read
that module's blind reference, and you must hand the result to an independent critic and
label it unreviewed. Self-verification is exactly what this process exists to distrust.

## Standing rules

- **Never mark a module complete on builder-green.** Rounds 1–3 were green on builder
  tests while critics found live-proven wrong behavior every time. Passing tests are a
  claim; a critic's verdict is evidence.
- **Reproduce a critic's headline claim yourself before dispatching a builder.** It is
  cheap, and a builder sent chasing a phantom wastes a whole round.
- **Send `BIGGEST_GAP` verbatim**, plus an explicit do-not-regress list naming what the
  critic verified as genuinely good. That list is what stops a fix costing more than it
  buys.
- **Whoever writes a builder prompt must not have read that module's blind reference.**
  The answer key leaks by paraphrase even with good intentions. Ready-to-fire,
  reference-blind prompts for M2–M6 are in `docs/BUILDER-PROMPTS.md`.
- **Correctness outranks speed.** q05, q06 and q07 return *wrong answers*. A report
  leading with a speedup on those has misjudged the situation.
- **q10 is a deliberate false-positive trap.** The textbook "move the non-aggregate
  filter out of `HAVING`" rule is wrong on PG 16 — the planner already pushes it down and
  the query runs in ~7 ms. Anything promising a speedup there is penalized.
- **Precision is graded as hard as recall.** `LIKE 'Customer 1%'` is sargable; flagging
  it is a false positive. False positives propagate to five downstream modules.
- **Verify against the live PostgreSQL 16.14, not against published advice.** Much of it
  is stale. PG 16 has no btree skip scan (that is PG 18).
- **Protect the database.** `sqlsage-pg` must always have **exactly 8 baseline indexes**.
  Run every experimental index or rewrite inside `BEGIN; … ROLLBACK;` or through
  `node eval/verify.ts`. Never destroy the container — PGDATA is an anonymous volume and
  `docker commit` does not capture it.
- **Do not run your own timing queries while a critic is measuring.** Concurrent load
  skews median-of-3 and corrupts the evidence you need to judge the verdict.
- **Keep `progress/state.json` current** (`node progress/serve.mjs` → http://localhost:5310),
  including score history and biggest gaps. It is a deliverable, not decoration.
- **A falling score is not automatically a regression.** M1 went 61 → 68 → 60 because a
  deeper gap was finally probed while both earlier defects stayed fixed. Read the critique
  before "restoring" anything.
- **If subagents fail instantly with a session-limit error, wait rather than retrying** —
  retrying burns the same quota. Instruct long-running agents to write their output file
  **incrementally**; one previous agent completed all its measurements and died before
  writing, losing everything.

## Report honestly

Do not describe SQLSage as complete, working, or end-to-end while any critic is
unconvinced. Say plainly which modules are unreviewed, which are rejected, and what is
missing. If you did builder work yourself, say so and say it is unreviewed.

## ⚠️ When context runs low

**When you reach roughly 90% context usage, stop taking on new work and update
`HANDOFF.md`.** Do not defer this — three subagents have already been lost mid-task to
session limits, and unwritten state is lost state.

The handoff must contain:

- what is **verified** versus what is merely **written but unreviewed**
- every measured number that would otherwise have to be re-derived, with the command that
  produced it
- exact blockers, with file paths and line numbers
- any shared-contract (`src/types.ts`) change, flagged explicitly — never silent
- what you did **not** do, and why
- the precise next action, in order

Prefer updating `HANDOFF.md` incrementally as you go over writing it all at the end.
