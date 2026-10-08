# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users:

- **Backend engineers** working on PostgreSQL-backed applications who have a suspicious
  or slow `SELECT` query but are not full-time database performance experts.
- **Data engineers and analysts** who write SQL daily and need the same help
  (audience broadened to include them; confirmed 2026-08-04).

Their situation: they have a concrete query that returns the wrong answer or runs
slowly. They want a trustworthy explanation and a safe, evidence-backed fix — often
without standing up a database connection or running a profiler.

## Product Purpose

SQLSage is a command-line PostgreSQL query explainer and optimizer. Given a `SELECT`
statement plus schema metadata (and optionally a saved or live plan), it:

- explains the query's result and behavior in plain English;
- flags wrong-result and business-intent risks before performance issues;
- describes predicted or observed execution behavior;
- recommends conservative indexes and rewrites as explicit change sets; and
- labels every claim as predicted, plan-observed, measured, or unverified.

Success means a user reaches a useful, trustworthy report in under five minutes and can
test the recommendation safely — then returns with another query.

## Positioning

"Correctness-first." SQLSage catches SQL correctness risks before performance problems
and attaches an explicit evidence label to every claim. It runs fully offline and never
executes recommended rewrites or candidate DDL — a trust posture a neighboring tool
cannot truthfully copy.

## Operating Context

- **CLI-first**: the product is a Node.js (>= 22.18) npm package used from a terminal;
  its web surface is the VitePress documentation site at figo5.github.io/sqlsage.
- **Inputs**: a `SELECT` statement plus a SQLSage catalog JSON or supported PostgreSQL
  DDL; optionally a saved PostgreSQL JSON plan, a reusable evidence bundle, or a live
  database connection.
- **The key journey**: install → provide query and schema/plan → useful report in under
  five minutes → test the recommendation safely → return with another query.
- **Output formats**: text, Markdown, and deterministic JSON. JSON goes to stdout;
  diagnostics go to stderr. Findings do not make the process fail — they are the output.
- **Read-only by default.** `--analyze` (read-only `EXPLAIN ANALYZE`) is explicit and
  opt-in; SQLSage never executes recommended rewrites or candidate index DDL, and never
  runs a query the user has not reviewed.
- `sqlsage doctor` validates the runtime, inputs, and (optionally) connectivity, and
  prints the exact corrective command on every failure; exits 0/1, so it is safe as a CI
  preflight. `sqlsage compare` diffs two captured plans and refuses verdicts the evidence
  cannot support (no timing verdict below 1.2x, prominent flag when the captures describe
  different statements).

## Capabilities and Constraints

Capabilities (v0.2.1):

- offline analysis from a query plus SQLSage catalog JSON or supported PostgreSQL DDL;
- saved-plan and reusable evidence-bundle analysis;
- optional safe live planning and explicitly enabled read-only `EXPLAIN ANALYZE`;
- correctness, business-intent, and performance findings;
- conservative index and query-rewrite change sets;
- text, Markdown, and deterministic JSON output;
- a twelve-query acceptance corpus and bundled catalog;
- commands `analyze`, `compare`, `demo`, `list`, `doctor`;
- npm package plus provenanced GitHub Release tarballs, released tag-driven through CI;
- a VitePress documentation site.

Constraints:

- Scope: PostgreSQL `SELECT` statements, including common CTE, subquery, join,
  aggregation, ordering, pagination, and window-function shapes. Unsupported DDL is
  rejected rather than silently returning partial metadata.
- Selectivity is deliberately declined for ranges, patterns, expressions, JSON, and
  correlated subqueries; a uniform fallback applies to equality alone.
- Every claim carries a provenance label; plan-derived prose states its source (live or
  saved × `EXPLAIN ANALYZE` or plan-only).
- Provenance is not persisted into an evidence bundle: a plan captured live and read back
  from a file is genuinely a saved plan.
- Two documented confident-wrong cases are published on the limitations page rather than
  hidden.
- Undecided: none material as of 2026-08-04; the roadmap's open items are targets, not
  commitments.

Terminology: "correctness risk", "business-intent risk", "evidence bundle", "change
set", "predicted / plan-observed / measured / unverified".

## Brand Commitments

- **Name**: SQLSage. npm `sqlsage`, repository `Figo5/sqlsage`, author Gio Fiore.
- **License and tagline**: MIT; "Correctness-first PostgreSQL query explainer and
  optimizer."
- **Docs site**: VitePress, dark appearance, theme-color `#3fb950` (green accent),
  `favicon.svg`, footer "MIT licensed · Analyzes PostgreSQL SELECT statements with an
  honest evidence model." / © 2026 Gio Fiore.
- **Voice**: honest and evidence-first. The product names where it has been wrong rather
  than claiming infallibility, and corrective output prints exact commands, never
  invented advice.
- **Roadmap commitments (confirmed current 2026-08-04)**: CLI-first; preserve
  live-analysis safety boundaries; recommendations never execute; hard non-priorities
  are a web dashboard, accounts/teams/billing, telemetry, LLM-generated explanations,
  multi-database engines, and a VS Code extension — none unless the owner explicitly
  changes strategy.

## Evidence on Hand

- Twelve-query acceptance corpus (`corpus/` with bundled `catalog.json`).
- Three complete tutorials with commands and numbers measured against a live 13.2M-row
  PostgreSQL 16 database (`docs/tutorials/`).
- First external-install evidence: the Windows path bug found by a real user, fixed in
  v0.2.1, with two recorded lessons (a diagnostic that blames the user's install for the
  tool's own bug is worse than none; CI ran one OS).
- CI matrices: ubuntu + windows × Node 22/24; a live PostgreSQL 14–17 service matrix.
- Roadmap exit criteria name evidence that does **not** exist yet and must not be
  fabricated: no published testimonials, case studies, or performance benchmarks; target
  of five successful real-query analyses with 10–15 recruited users.

## Product Principles

1. **Correctness before performance.** A wrong answer is the failure that matters most,
   so it is surfaced before performance concerns.
2. **Evidence over assertion.** Every claim carries a provenance label; reports state
   what is predicted, observed, or measured — and where the tool has been wrong.
3. **Safety by default.** SQLSage never executes rewrites or DDL, and reads data only in
   explicitly enabled, read-only modes.
4. **Honesty over confidence.** Known gaps and past mistakes are documented and surfaced,
   not hidden.
5. **Frictionless first use.** An unfamiliar user should succeed — install, first report,
   safe test — without reading all of the documentation.
