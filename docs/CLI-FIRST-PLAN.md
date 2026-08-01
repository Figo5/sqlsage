# SQLSage CLI-first product plan

**Status:** CLI-first objective complete and release-ready as of 2026-08-01. This document supersedes
the builder/critic-loop ordering in `docs/CODEX-PROMPT.md` and the old completion rule
in `HANDOFF.md`. Earlier reports remain evidence and regression material, not the
roadmap.

## Product promise

SQLSage is a PostgreSQL command-line tool that explains what a query returns, identifies
correctness and intent risks before performance work, explains likely or observed
execution behavior, and proposes evidence-calibrated indexes and rewrites.

The first release is useful without a database connection and becomes more precise when
the user supplies a saved plan or a live PostgreSQL connection. It never presents a
module that did not run as a clean bill of health.

## Current release state

- M1 through M7 run by default. M1 retains 406 corpus/synthetic assertions and the
  complete test suite exercises every module through the CLI.
- Catalog JSON, supported PostgreSQL schema SQL, saved JSON plans, and live PostgreSQL
  are working metadata/evidence sources.
- Live planning is non-executing by default. Explicit `--analyze` is read-only,
  timeout-bounded, schema-bound before EXPLAIN, rollback-contained, and never runs
  recommended SQL or DDL.
- Text, Markdown, and reusable JSON evidence output have stable exit behavior and
  concise errors.
- All twelve corpus workflows pass the named release gates. A packed tarball installs
  into a fresh prefix and runs the bundled workflow from built JavaScript.
- One bounded product review found three release blockers. False completeness for
  non-SELECT input, a missing live-execution safety warning in help, and uncaught closed
  output pipes are fixed with process-level regressions; the full release suite passed
  afterward.

## Supported MVP scope

- PostgreSQL `SELECT` statements, including CTEs, subqueries, joins, grouping, windows,
  ordering, limits, and set operations that M1 can bind safely.
- One statement per invocation.
- Offline analysis from either schema SQL, catalog JSON, or a SQLSage plan bundle.
- Optional raw PostgreSQL JSON plan when schema or catalog metadata is also supplied.
- Optional live catalog introspection and plan collection from PostgreSQL 16 or newer.

Explicit non-goals for the first CLI release:

- Executing recommended rewrites or indexes automatically.
- Tuning DML, DDL, stored procedures, or cross-database SQL dialects.
- Guaranteeing a speedup without measured evidence.
- Replacing load testing, production monitoring, or a human review of business intent.
- A web interface, hosted service, or account system before the CLI is useful.

## Command contract

Primary command:

```text
sqlsage analyze [query source] [metadata source] [options]
```

Query source — exactly one:

```text
--query query.sql       read SQL from a file
--sql "SELECT ..."      use an inline statement
- / piped stdin         read SQL from standard input
```

Metadata and evidence:

```text
--schema schema.sql             parse common CREATE TABLE/INDEX schema SQL
--catalog catalog.json          load SQLSage's lossless catalog format
--plan plan.json                load raw PostgreSQL JSON or a SQLSage evidence bundle
--database-url "$DATABASE_URL"  introspect a live database and collect a plan
--schema-name public            live schema to inspect (default: public)
```

Output and safety:

```text
--format text|markdown|json     default: text for a TTY, markdown when redirected
--analyze                       explicitly opt in to EXPLAIN ANALYZE
--statement-timeout 5000        live planning/execution timeout in milliseconds
--no-color                      force control-free text
```

Development/demo commands may retain `--corpus` and `--list`, but help must label them as
examples rather than the primary workflow.

Exit codes:

- `0`: analysis completed and the requested output was written. Findings are product
  output, not process failure.
- `1`: command usage, input file, catalog/schema, connection, or output failure.
- `2`: SQL could not be parsed/bound safely, a non-SELECT statement was supplied, or
  analysis was otherwise blocked before a trustworthy report could be produced.

Ordinary user mistakes produce one concise diagnostic on stderr and no stack trace.
Machine-readable JSON writes only JSON to stdout.

## Pipeline and evidence model

```text
SQL + Catalog
    -> M1 bound QueryIR
    -> M2 semantic explanation
    -> M3 predicted execution
    -> M4 correctness / intent / performance findings
    -> M5 index recommendations
    -> M6 rewrites with exact M5 dependencies
    -> M7 report or deterministic JSON envelope

Optional PlanEvidence augments M3/M4 and calibrates claims as observed.
```

Offline analysis must label access paths, costs, speedups, and equivalence as predicted or
unverified. A saved non-ANALYZE plan provides observed planner choices but not measured
runtime. Only an opted-in `EXPLAIN ANALYZE` plan may support measured runtime language.

M2–M6 should be structural rules over IR, catalog facts, and plan nodes. Corpus IDs, exact
SQL strings, and query fingerprints are forbidden. The corpus is an acceptance suite, not
the implementation.

## Live PostgreSQL safety contract

Default connected mode runs `EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON)` only. It does not
execute the query.

`--analyze` is deliberately harder:

1. M1 must prove the input is one `SELECT` statement.
2. Start a transaction with `READ ONLY` and a local statement timeout.
3. Run one `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)`.
4. Roll back in `finally`, even after timeout or server error.
5. Never run candidate DDL, rewrites, or `CREATE INDEX CONCURRENTLY` from the CLI.

Read-only mode prevents database writes but cannot prevent every external side effect of
a user-defined volatile function. Help and README must state that limitation before the
user opts in.

## Delivery milestones

### Milestone 1 — complete offline vertical slice (complete)

- Replace the placeholder pipeline with default M2–M6 implementations.
- Give all twelve corpus queries non-placeholder semantics, execution assessment,
  findings, index assessment, and rewrite assessment (including an explicit, justified
  “no recommendation” when appropriate).
- Implement strict `analyze` argument parsing, query file/stdin/inline input, catalog JSON,
  text/Markdown/JSON output, clean errors, and stable exits.
- Add subprocess smoke tests for help, file input, stdin, JSON, bad SQL, bad files, and
  offline success.

User-visible checkpoint: a fresh shell can run a real query against catalog metadata and
receive a complete report without PostgreSQL running.

### Milestone 2 — schema SQL and saved plans (complete)

- Parse the common PostgreSQL `CREATE TABLE`, primary/foreign key, nullability, and
  `CREATE INDEX` subset into `Catalog`; reject unsupported schema constructs clearly.
- Accept raw PostgreSQL JSON plans and SQLSage evidence bundles.
- Make M3 prefer observed plan nodes over offline prediction without calling estimated
  data measured.
- Add fixtures and smoke tests for both input paths.

User-visible checkpoint: `sqlsage analyze --query query.sql --schema schema.sql` and
`--plan plan.json` both work offline.

### Milestone 3 — safe connected PostgreSQL (complete)

- Add database URL connection, live schema introspection, and non-executing JSON EXPLAIN.
- Add explicit, read-only, timed `--analyze` behavior.
- Save or emit a reusable evidence bundle for later offline analysis.
- Add one connected integration test against `sqlsage-pg` without persistent changes.

User-visible checkpoint: a user can point SQLSage at PostgreSQL and get plan-aware advice
without executing the query by default.

### Milestone 4 — acceptance, packaging, and five-minute onboarding (complete)

- Run all twelve queries end to end in text, Markdown, and JSON.
- Enforce the named q01/q05/q06/q07/q10 product gates below.
- Add `bin`, `engines`, curated package `files`, scripts, and install smoke coverage.
- Write `README.md` with installation, a five-minute offline example, connected safety,
  input formats, evidence labels, limitations, and example output.
- Run one bounded independent product review. Fix release-blocking safety/correctness/CLI
  failures; put polish and conservative false rejects in the backlog.

## Corpus release gates

- q01: the half-open-range rewrite and `(status, created_at)` index are one change set;
  never recommend the measured-slower index alone.
- q05: nullable-subquery `NOT IN` is a correctness blocker and `NOT EXISTS` changes the
  current wrong result intentionally.
- q06: aggregate fan-out is a correctness blocker; performance advice comes second.
- q07: ask which population the user intends. Do not silently pick outer- or inner-join
  semantics.
- q10: no promised speedup for moving the grouping-key predicate out of `HAVING` on
  PostgreSQL 16; the planner already pushes it down.
- Every runtime or speed claim says predicted, plan-observed, measured, or unverified.

## Quality and backlog policy

Release blockers:

- wrong-result advice, unsafe SQL/DDL, false completeness, fabricated measurements,
  crashes, corrupt JSON, unstable exit behavior, or an unusable primary workflow.

Backlog unless they block a real CLI path:

- conservative rejection of uncommon valid DDL, presentation-only Markdown defects,
  duplicated low-level notes, and other lower-risk Round-8 findings.

Tests are release evidence only when they cover the user workflow. Assertion counts and
critic scores are not product milestones. Persistent `shop` indexes must remain exactly
eight throughout development.

Distribution backlog: `package.json` remains `private: true`. The tarball and installed
CLI are verified; registry publication requires an explicit product decision.
