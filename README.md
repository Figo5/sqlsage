# SQLSage

[![npm](https://img.shields.io/npm/v/sqlsage)](https://www.npmjs.com/package/sqlsage)
[![CI](https://github.com/Figo5/sqlsage/actions/workflows/ci.yml/badge.svg)](https://github.com/Figo5/sqlsage/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Figo5/sqlsage)](https://github.com/Figo5/sqlsage/releases/latest)
[![Docs](https://img.shields.io/badge/docs-figo5.github.io%2Fsqlsage-3fb950)](https://figo5.github.io/sqlsage/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

SQLSage is a command-line PostgreSQL query explainer and optimizer. Give it a
`SELECT` statement plus schema metadata and it will:

- explain the result in plain English;
- flag wrong-result and business-intent risks before performance issues;
- describe predicted or observed execution behavior;
- recommend conservative indexes and rewrites as explicit change sets; and
- label every claim as predicted, plan-observed, measured, or unverified.

SQLSage can run completely offline. A database connection is optional.

## Install

Requirements: Node.js 22.18 or newer (Node 22 LTS and Node 24 are both tested in CI) and npm.

```bash
npm install --global sqlsage
sqlsage --version
```

Or run it without installing:

```bash
npx sqlsage demo
```

Each [GitHub release](https://github.com/Figo5/sqlsage/releases) also carries a tarball
and `SHA256SUMS.txt` if you would rather install from a verified download.

## Try it in 30 seconds

One command, no files and no database:

```bash
sqlsage demo
```

It analyzes a bundled query with a nullable `NOT IN` correctness bug: SQLSage explains
why the query can return no rows, proposes a `NOT EXISTS` repair, labels the intentional
result change, and then prints the commands for analyzing your own query.

SQLSage also includes a demonstration catalog and twelve realistic queries:

```bash
sqlsage list
sqlsage analyze --corpus q05 --format text
```

## Tutorials

Three complete walkthroughs, each with commands and output verified against a live
PostgreSQL 16 database:

1. [Catching a query that returns the wrong answer](docs/tutorials/01-wrong-results-not-in.md)
   — a nullable `NOT IN` that silently returns zero rows instead of 196,000. No database needed.
2. [Fixing a date filter an index cannot help](docs/tutorials/02-non-sargable-date.md)
   — why adding the index alone changes nothing, and the rewrite plus index is 5.5x faster.
3. [Analyzing a real plan from your own database](docs/tutorials/03-real-explain-plan.md)
   — `pg_dump`, `EXPLAIN (ANALYZE, FORMAT JSON)`, and reading where the planner was wrong.

## Check your environment

`sqlsage doctor` validates the runtime, any input files you pass, and — if you supply a
connection string — database connectivity and permissions. Every failure prints the exact
command that fixes it.

```bash
sqlsage doctor
sqlsage doctor --catalog catalog.json --schema schema.sql
sqlsage doctor --database-url "$DATABASE_URL" --schema-name public
```

It is strictly read-only: it never issues DDL or DML, never runs `EXPLAIN ANALYZE`, and
never executes your query. It exits 0 when every check passes and 1 when any check fails,
so it is safe to use as a CI preflight step.

## Analyze your own query

With a PostgreSQL schema file:

```bash
sqlsage analyze --query query.sql --schema schema.sql
```

With SQLSage catalog JSON:

```bash
sqlsage analyze --query query.sql --catalog catalog.json
```

From standard input, producing machine-readable output:

```bash
cat query.sql | sqlsage analyze --schema schema.sql --format json > analysis.json
```

Available formats are `text`, `markdown`, and `json`. JSON output is written only to
stdout; diagnostics are written to stderr.

## Use a saved PostgreSQL plan

Pair raw `EXPLAIN (FORMAT JSON)` output with schema metadata:

```bash
sqlsage analyze \
  --query query.sql \
  --catalog catalog.json \
  --plan plan.json
```

Plan-aware JSON output is a reusable evidence bundle:

```bash
sqlsage analyze --query query.sql --catalog catalog.json --plan plan.json \
  --format json > evidence.json
sqlsage analyze --query query.sql --plan evidence.json
```

If a bundle contains SQL, it must match the query being analyzed. SQLSage rejects
mismatched evidence.

## Connect to PostgreSQL safely

Connected mode collects a plan without executing the query by default:

```bash
sqlsage analyze \
  --query query.sql \
  --database-url "$DATABASE_URL" \
  --schema-name public
```

This uses `EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON)` inside a timed, read-only
transaction and rolls back. The query must parse and bind as one supported `SELECT`
before PostgreSQL receives `EXPLAIN`.

Execution is explicit:

```bash
sqlsage analyze \
  --query query.sql \
  --database-url "$DATABASE_URL" \
  --schema-name public \
  --analyze \
  --statement-timeout 5000
```

`--analyze` executes one `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT
JSON)`. Read-only mode prevents database writes, but it cannot prevent external side
effects inside an unfamiliar user-defined volatile function. Review the query before
opting in.

SQLSage never executes recommended rewrites or candidate index DDL.

## Compare two plans

```bash
sqlsage compare --before before.json --after after.json
```

Reports what changed between two captured plans — access paths, indexes, join
strategies, spills, row-estimate accuracy — and whether it measurably improved.

It refuses verdicts the evidence cannot support: no timing comparison when either side
is plan-only, no "improvement" claimed below 1.2x since two single runs cannot separate
that from noise, and a prominent flag when the two captures describe different
statements. `compare` never executes a query.

## Exit codes

- `0`: analysis completed and output was written;
- `1`: usage, input, connection, plan, or output failure;
- `2`: unsupported, unparseable, unbound, or incomplete analysis.

Findings do not make the process fail; they are the product output.

## Supported scope

The current release supports PostgreSQL `SELECT` statements, including common CTE,
subquery, join, aggregation, ordering, pagination, and window-function shapes.

The offline schema importer supports common `CREATE SCHEMA`, `SET search_path`,
`CREATE TABLE`, primary/foreign keys, nullability, and PostgreSQL index definitions.
It rejects unsupported DDL rather than silently returning partial metadata.

See [Supported constructs](docs/SUPPORTED.md) for the measured list of what is accepted
and rejected, [Limitations and known gaps](docs/LIMITATIONS.md) for where the advice is
weak and where SQLSage has been wrong, [Usage and inputs](docs/USAGE.md) for the full
input contract, and [Architecture](docs/ARCHITECTURE.md) for the analysis pipeline.

## Build from source

```bash
git clone https://github.com/Figo5/sqlsage.git
cd sqlsage
npm ci
npm run check
npm link
```

The package ships built JavaScript in `dist/`. The install smoke test packs the
project, installs it into a fresh temporary prefix, imports the package API, and runs
the CLI:

```bash
npm run test:install
```

## Contributing and security

Bug reports and focused pull requests are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before changing analysis rules, and report security
issues according to [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
