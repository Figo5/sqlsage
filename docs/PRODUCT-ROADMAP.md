# SQLSage Product Roadmap

Last updated: 2026-08-01 (Phase 1: demo, doctor, and release automation landed)

## Purpose

This document is the product and growth roadmap for SQLSage. It is intended to be
usable as context for maintainers and future coding sessions. It describes priorities;
it does not authorize implementing them without a specific request from the owner.

## Current product state

SQLSage v0.1.0 is a public, CLI-first PostgreSQL query explainer and optimizer.

Current capabilities include:

- offline analysis from a query plus SQLSage catalog JSON or supported PostgreSQL DDL;
- saved PostgreSQL JSON plan and reusable evidence-bundle analysis;
- optional safe live planning and explicitly enabled read-only `EXPLAIN ANALYZE`;
- correctness, business-intent, and performance findings;
- conservative index and query-rewrite change sets;
- text, Markdown, and deterministic JSON output;
- a twelve-query acceptance corpus;
- an installable GitHub Release package with automated CI and checksums; and
- `sqlsage demo` and `sqlsage doctor` for first-run success and environment validation.

Not yet on npm: installation is still via GitHub Release tarball or a source build. The
release workflow is ready to publish; see [Releasing](RELEASING.md) for the one-time
maintainer step that unblocks it.

Repository: <https://github.com/Figo5/sqlsage>

Latest release: <https://github.com/Figo5/sqlsage/releases/tag/v0.1.0>

## Product direction

SQLSage's strongest position is:

> Catch SQL correctness risks first, then explain performance problems and propose
> evidence-backed PostgreSQL improvements.

The initial audience should be backend engineers who have a suspicious or slow
PostgreSQL `SELECT` query but are not full-time database performance experts.

The key user journey is:

1. Install SQLSage.
2. Provide a query and schema or plan.
3. Receive a useful report in under five minutes.
4. Test the recommendation safely.
5. Return with another query.

Everything on this roadmap should improve one of those steps.

## Phase 1: Frictionless first use

Target window: weeks 1–4

Goal: let an unfamiliar user succeed without reading all of the documentation.

### Product priorities

- Publish on npm so installation becomes `npm install --global sqlsage` or
  `npx sqlsage`. **Release automation done; not yet published.** The release workflow
  publishes via npm trusted publishing, but npm can only attach a trusted publisher to a
  package that already exists, so the first publish is a manual maintainer step. See
  [Releasing](RELEASING.md).
- Use npm trusted publishing through GitHub Actions to avoid long-lived publishing
  tokens and produce build provenance. **Done** — `.github/workflows/release.yml` uses
  OIDC (`id-token: write`), stores no npm token, verifies the tag matches
  `package.json`, and skips publishing a version already on the registry.
- Investigate supporting Node.js 22 as well as Node.js 24. **Done — Node 22 is
  supported.** Verified on Node 22.23.2 in a clean container: the full suite (150 tests),
  `eval/dump-ir.ts --check` (406 assertions), `eval/run.ts` (12/12), the build, and the
  install smoke test all pass, as do `demo`, `doctor`, and every analyze path. Native
  type stripping works from Node 22.18, which is why the floor is `>=22.18.0` rather
  than `>=22.0.0`. The esbuild target moved from `node24` to `node22`, and CI now runs a
  `[22.x, 24.x]` matrix so the claim stays true.
- Add `sqlsage demo` for an immediate self-contained example. **Done** — analyzes a
  bundled nullable `NOT IN` query with no files, flags, or database, and ends with the
  commands for analyzing the user's own query. It rejects input flags rather than
  ignoring them.
- Add `sqlsage doctor` to validate the runtime, input files, database connectivity,
  and PostgreSQL permissions. **Done** — checks the Node version against `engines`,
  bundled assets, an end-to-end self-test, any supplied catalog/schema/plan file, and
  (with `--database-url`) server version, authentication, read-only `EXPLAIN`, schema
  visibility, table read permission, and planner statistics. Strictly read-only; refuses
  `--analyze`. Exits 0 all-pass, 1 on any failure.
- Improve error messages with exact corrective commands. **Partly done** — every
  `doctor` failure prints an exact corrective command. The `analyze` path's usage,
  catalog, schema, and plan errors have not yet been given the same treatment.
- Create three complete tutorials:
  - catching a wrong-result `NOT IN` query;
  - fixing a non-sargable date predicate; and
  - analyzing a real PostgreSQL JSON plan.
- Document exactly which SQL and schema constructs are supported. **Done** — see
  [Supported constructs](SUPPORTED.md). Every entry is measured by `eval/scope-probe.ts`
  rather than inferred from source, and the probe is re-runnable after parser changes.
- Add a short terminal recording or animated demonstration to the README.

### User acquisition

- Personally recruit 10–15 backend or PostgreSQL users.
- Observe them installing and running SQLSage on a real query.
- Avoid a large public launch until at least five unfamiliar users succeed without
  assistance.

### Exit criteria

- Five users successfully analyze real queries.
- Median time to first useful report is under five minutes.
- No recurring installation blocker remains.
- At least three pieces of actionable external feedback are collected.

## Phase 2: Establish trust

Target window: weeks 5–8

Goal: prove that SQLSage's advice is dependable, not merely convincing-looking.

### Product priorities

- Support common missing schema constructs. Measured status (`eval/scope-probe.ts`):
  - `ALTER TABLE` — not supported;
  - unique constraints — **done.** Column, table, composite, and named `UNIQUE` inside
    `CREATE TABLE` all become unique indexes and feed the join fan-out proof. `UNIQUE`
    correctly does not imply `NOT NULL`. Only the `ALTER TABLE` spelling remains, blocked
    on `ALTER TABLE` itself;
  - generated and identity columns — not supported;
  - `CHECK` constraints — not supported;
  - partitioned tables (`PARTITION BY`) — not supported;
  - views and materialized views — not supported; and
  - **multi-schema references — already supported**, including cross-schema foreign keys.
    Measured, correcting an earlier assumption in this document.
- Support query parameters such as `$1`, `$2`, and typed placeholders. Measured: these
  already **bind** without error, so a report is produced — but a placeholder carries no
  value, so selectivity and index advice fall back to defaults. The gap is advice quality,
  not parsing.
- Add `sqlsage compare` for comparing saved plans or before-and-after query versions.
- Show estimated-versus-actual row errors prominently.
- Test supported PostgreSQL versions in CI.
- Expand the regression corpus with sanitized real-user queries.
- Use dedicated issue labels for false positives, false negatives, unsafe
  recommendations, unsupported SQL, plan interpretation, and documentation.
- Publish a transparent limitations and known-gaps page.

PostgreSQL recommends machine-readable plan formats for programmatic analysis and
warns that `EXPLAIN ANALYZE` actually executes the query. SQLSage should retain those
distinctions as core trust boundaries.

Reference: <https://www.postgresql.org/docs/current/using-explain.html>

### User acquisition

- Publish three evidence-backed case studies.
- Each case study should include the original query, plan, SQLSage report, applied
  change, new plan, and measured outcome.
- Enable GitHub Discussions for questions, examples, and roadmap conversations.

### Exit criteria

- At least 25 real-world queries have been evaluated.
- No known confident-but-wrong recommendation remains open.
- At least 70 percent of early users describe the report as useful.
- At least five users return with another query.

## Phase 3: Make SQLSage part of development

Target window: months 3–4

Goal: move from a one-time diagnostic tool to a repeatable development workflow.

### Product priorities

- Add batch analysis for a directory of SQL files.
- Introduce a stable, versioned JSON output contract.
- Build an official GitHub Action.
- Allow teams to review SQL changes in pull requests.
- Add configurable severity thresholds and CI exit behavior.
- Add SARIF output for code-scanning integrations.
- Accept plans exported from common PostgreSQL monitoring tools.
- Add `pg_stat_statements` import for ranking workload candidates.
- Generate a sanitized support bundle users can attach to issues.
- Add project configuration through a committed `sqlsage.config.json`.

### Distribution

- Maintain npm as the primary CLI distribution channel.
- Add a Docker image for environments without a local Node.js toolchain.
- Consider Homebrew and native executables only after demand is demonstrated.

Node.js single-executable applications may eventually remove the Node.js installation
requirement, but the feature remains under active development and has packaging
constraints.

Reference:
<https://nodejs.org/download/release/v25.6.0/docs/api/single-executable-applications.html>

### Exit criteria

- At least three repositories run SQLSage in CI.
- At least 10 recurring users are identified.
- External pull requests or corpus contributions begin arriving.
- The JSON contract survives two releases without an accidental breaking change.

## Phase 4: Build the technical moat

Target window: months 5–6

Goal: improve SQLSage through accumulated real-world evidence.

### Product priorities

- Workload-level analysis instead of isolated-query analysis.
- Before-and-after plan regression detection.
- Index overlap, redundancy, write-cost, and storage-impact analysis.
- Better cardinality and statistics recommendations.
- Partition pruning and parallel-plan analysis.
- Support for more advanced PostgreSQL operators and index types.
- Cross-query index recommendations that avoid suggesting one index per query.
- Verification workflows that test rewrites for result equivalence.
- A growing public corpus of anonymized performance incidents.
- Rule confidence calibrated from real false-positive and false-negative reports.

### Potential integrations

- GitHub pull requests.
- Migration tools.
- ORM query logs.
- PostgreSQL monitoring platforms.
- Editor integrations after the CLI and JSON API are stable.

## Growth loop

The sustainable acquisition loop should be:

```text
Real query problem
    -> SQLSage analysis
    -> evidence-backed fix
    -> published case study
    -> new user discovers SQLSage
    -> new real-world query improves the corpus
```

The best marketing material will be concrete investigations rather than generic
announcements.

### Metrics

Track:

- release downloads;
- npm weekly downloads;
- unique repository visitors and clones;
- successful first analyses;
- returning users;
- external issues and contributions; and
- false-positive and unsafe-recommendation rates.

GitHub exposes repository traffic for only the previous 14 days, so these numbers
should be recorded regularly if they are used for trend analysis.

Reference:
<https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository>

## What not to prioritize yet

- A web dashboard.
- Accounts, teams, or billing.
- Multiple database engines.
- LLM-generated explanations.
- A VS Code extension.
- Enterprise authentication.
- Anonymous telemetry without explicit consent.
- Native binaries before npm onboarding is validated.

These directions may eventually be valuable, but they would currently dilute the
CLI-first advantage and slow learning from actual PostgreSQL users.

## Immediate milestone

The next milestone is:

> Recruit 10 external users, complete five successful real-query analyses, and use
> their feedback to define the first genuinely user-driven release.

## Instructions for future coding sessions

When this document is provided to a coding assistant:

1. Treat it as strategic context, not authorization to implement the entire roadmap.
2. Ask which phase, milestone, or issue the owner wants to pursue.
3. Preserve the CLI-first, correctness-first, evidence-labeled product direction.
4. Do not add a web interface, accounts, telemetry, multi-database support, or
   LLM-generated analysis unless the owner explicitly changes the strategy.
5. Keep recommendations non-executing and preserve SQLSage's live-analysis safety
   boundaries.
6. Define a user-visible outcome and acceptance criteria before implementation.
7. Update this roadmap only when product priorities or measured evidence change.

## Supporting references

- npm trusted publishing:
  <https://docs.npmjs.com/trusted-publishers/>
- npm provenance verification:
  <https://docs.npmjs.com/viewing-package-provenance/>
- GitHub Discussions:
  <https://docs.github.com/en/enterprise-cloud@latest/discussions/collaborating-with-your-community-using-discussions/about-discussions>
- PostgreSQL `EXPLAIN`:
  <https://www.postgresql.org/docs/current/using-explain.html>
