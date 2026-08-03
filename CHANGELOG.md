# Changelog

All notable changes to SQLSage are documented here.

## 0.2.0 — 2026-08-02

Additive throughout: no breaking changes. `engines` widened rather than narrowed, and
every shared-contract field added is optional.

### New commands

- `sqlsage demo` — analyzes a bundled nullable `NOT IN` query with no files, flags, or
  database, then prints the commands for analyzing your own query. Input flags are
  rejected rather than ignored.
- `sqlsage doctor` — validates the Node version against `engines`, bundled assets, an
  end-to-end self-test, any supplied catalog/schema/plan file, and with
  `--database-url` the server version, authentication, read-only `EXPLAIN`, schema
  visibility, table read permission, and planner statistics. Strictly read-only, refuses
  `--analyze`, exits 0 all-pass and 1 on any failure.
- `sqlsage compare --before a.json --after b.json` — diffs two captured plans: access
  paths per relation, indexes gained and lost, join-strategy changes, spills, the worst
  row misestimate on each side, and a timing verdict. Refuses verdicts two captures
  cannot support and never executes a query.

### Schema support

- `UNIQUE` as a column or table constraint, composite and named forms. `UNIQUE` correctly
  does not imply `NOT NULL`.
- `ALTER TABLE`: `ADD CONSTRAINT`, `ADD COLUMN`, `ALTER COLUMN SET`/`DROP NOT NULL`,
  comma-separated actions, `ONLY`, `IF EXISTS`.
- Real `pg_dump --schema-only` output, including the `\restrict`/`\unrestrict` psql
  meta-commands recent versions emit, dollar-quoted function bodies, ownership, grants,
  comments, sequences, extensions, and enum types.
- Generated and identity columns; `CHECK` constraints accepted with the predicate not
  modelled.
- Partitioned tables, enforcing PostgreSQL's rule that a unique constraint must cover the
  partition key.
- Views and materialized views. No index is ever recommended for a plain view, which has
  no storage.
- Live introspection reports views, materialized views and partitioned tables too, so the
  offline and connected paths agree on which relations exist.

### Reports

- Estimated-versus-actual row errors now lead, ranked by total rows misjudged rather than
  by ratio, with severe misestimates called out prominently.
- Plan-derived prose states its provenance — `live` or `saved`, crossed with
  `EXPLAIN ANALYZE` or `plan-only EXPLAIN` — instead of always claiming "saved".
- A rewrite and the index it declares in `requiresIndexes` render as one coupled step.
  Applying the index alone is measurably worthless on the corpus q01 case.

### Platform and tooling

- Node.js 22.18 or newer is now supported, alongside 24. CI runs a `[22.x, 24.x]` matrix.
- CI runs a PostgreSQL `[14, 15, 16, 17]` service matrix exercising the connected path.
- `analyze` failures now print an exact corrective command, matching `doctor`.
- Three tutorials in `docs/tutorials/`, and a measured
  [supported-constructs](docs/SUPPORTED.md) reference.

### Fixed

- An `EXCLUDE` table constraint fell through to the column parser and produced a phantom
  column named `exclude`.
- `reltuples` is `-1` for a never-analyzed relation, which would have been reported as a
  negative row count and rejected by catalog validation.

## 0.1.0 — 2026-08-01

- Added the installable `sqlsage analyze` command.
- Added file, inline, and standard-input query sources.
- Added catalog JSON and PostgreSQL schema SQL inputs.
- Added saved PostgreSQL JSON plan and reusable evidence-bundle support.
- Added safe live PostgreSQL planning and explicit read-only `--analyze` mode.
- Added text, Markdown, and deterministic JSON output.
- Added correctness-first rules for nullable `NOT IN`, aggregate fan-out, outer-join
  intent, non-sargable predicates, deep pagination, repeated correlated work, JSON
  extraction, and related index/rewrite change sets.
- Added a twelve-query PostgreSQL acceptance corpus and package installation smoke test.
