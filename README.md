# SQLSage

[![CI](https://github.com/Figo5/sqlsage/actions/workflows/ci.yml/badge.svg)](https://github.com/Figo5/sqlsage/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Figo5/sqlsage)](https://github.com/Figo5/sqlsage/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

SQLSage is a command-line PostgreSQL query explainer and optimizer. Give it a
`SELECT` statement plus schema metadata and it will:

- explain the result in plain English;
- flag wrong-result and business-intent risks before performance issues;
- describe predicted or observed execution behavior;
- recommend conservative indexes and rewrites as explicit change sets; and
- label every claim as predicted, plan-observed, measured, or unverified.

SQLSage can run completely offline. A database connection is optional.

## Download and install

Requirements: Node.js 22.18 or newer (Node 22 LTS and Node 24 are both tested in CI) and npm.

Download the current package from the
[v0.1.0 release](https://github.com/Figo5/sqlsage/releases/tag/v0.1.0), then install it:

```bash
npm install --global ./sqlsage-0.1.0.tgz
sqlsage --version
```

You can also install directly from the release URL:

```bash
npm install --global https://github.com/Figo5/sqlsage/releases/download/v0.1.0/sqlsage-0.1.0.tgz
```

The release includes `SHA256SUMS.txt` so you can verify the download before
installation.

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

See [Usage and inputs](docs/USAGE.md) for the full input contract and
[Architecture](docs/ARCHITECTURE.md) for the analysis pipeline.

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
