# Getting Started

## Requirements

- **Node.js 22.18 or newer.** Node 22 LTS and Node 24 are both tested in CI.
- **npm.** Any recent version.

SQLSage can run completely offline. A database connection is optional and only
needed for the live-plan features.

## Install

```bash
npm install --global sqlsage
sqlsage --version
```

Or run it without installing:

```bash
npx sqlsage demo
```

Each [GitHub release](https://github.com/Figo5/sqlsage/releases) also carries a
tarball and `SHA256SUMS.txt` if you prefer to install from a verified download.

## The 30-second demo

```bash
sqlsage demo
```

It analyzes a bundled query with a nullable `NOT IN` correctness bug. SQLSage
explains why the query can return no rows, proposes a `NOT EXISTS` repair, labels
the intentional result change, and then prints the commands for analyzing your own
query. No database, no files, no setup.

## Check your environment

```bash
sqlsage doctor
```

`doctor` validates the runtime, any input files you pass, and — if you supply a
connection string — database connectivity and permissions. Every failure prints the
exact command that fixes it:

```bash
sqlsage doctor --catalog catalog.json --schema schema.sql
sqlsage doctor --database-url "$DATABASE_URL" --schema-name public
```

It is strictly read-only: it never issues DDL or DML, never runs `EXPLAIN ANALYZE`,
and never executes your query. It exits `0` when every check passes and `1` when any
check fails, so it is safe to use as a CI preflight step.

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
stdout; diagnostics are written to stderr. The default format is terminal text on a
TTY and Markdown when output is redirected.

### Query sources

Choose exactly one:

```text
--query query.sql          # a SQL file
--query -                  # standard input
--sql "SELECT ..."         # inline SQL
--corpus q05               # a bundled example
query.sql                  # positional file
"SELECT ..."               # positional inline SQL
```

## What the output looks like

For a query that returns the wrong answer, SQLSage leads with correctness:

```text
WRONG RESULTS
This query returns wrong answers today. Fix that before you spend a minute on
its speed.

Nullable NOT IN subquery can invalidate anti-membership. SQL NOT IN becomes
UNKNOWN for every otherwise-unmatched outer row if this subquery emits even one
NULL.
```

The full report covers result grain, predicted or observed execution, findings,
index recommendations, and rewrites — each claim labeled by its evidence level.
See the [CLI reference](/cli-reference) for every command and flag.

## Exit codes

- `0` — analysis completed and output was written;
- `1` — usage, input, connection, plan, or output failure;
- `2` — unsupported, unparseable, unbound, or incomplete analysis.

Findings do not make the process fail; they are the product output.

## Next steps

- Walk through the [three tutorials](/tutorials/01-wrong-results-not-in).
- Read the [CLI reference](/cli-reference) for every command and flag.
- See the [bundled examples](/examples) you can analyze with `--corpus`.
- Understand the pipeline in [Architecture](/ARCHITECTURE).
