# SQLSage

SQLSage is a PostgreSQL query explainer and optimizer for the command line. It
explains what a `SELECT` returns, puts correctness and business-intent risks ahead
of speed, describes predicted or observed execution, and proposes conservative
rewrites and indexes as explicit change sets.

It works offline from catalog JSON or schema SQL, can consume saved PostgreSQL JSON
plans, and can safely collect a plan from a live PostgreSQL database. It never runs
recommended rewrites or candidate DDL.

## Requirements and installation

SQLSage currently requires Node.js 24 or newer.

From this source tree:

```bash
npm install
npm run build
npm link
sqlsage --help
```

The npm package ships built JavaScript in `dist/`; it does not depend on Node's
repository-only TypeScript stripping. To verify the packaged binary in a fresh
temporary install:

```bash
npm run test:install
```

## Five-minute offline workflow

Analyze inline SQL against catalog metadata:

```bash
sqlsage analyze \
  --sql "SELECT customer_id, email FROM shop.customers WHERE loyalty_tier = 'gold'" \
  --catalog ./corpus/catalog.json \
  --format text
```

Files and standard input are first-class query sources:

```bash
sqlsage analyze --query query.sql --catalog catalog.json --format markdown
cat query.sql | sqlsage analyze --catalog catalog.json --format json > analysis.json
```

`text` is wrapped for a terminal, `markdown` is suitable for tickets and pull
requests, and `json` is a deterministic machine-readable envelope. JSON mode writes
JSON only to stdout; diagnostics go to stderr.

## Metadata and plan inputs

Use a PostgreSQL schema file instead of catalog JSON:

```bash
sqlsage analyze --query query.sql --schema schema.sql
```

The schema importer supports common `CREATE SCHEMA`, `SET search_path`, `CREATE
TABLE`, primary/foreign keys, nullability, and PostgreSQL index definitions. It
rejects unsupported DDL instead of returning a catalog it only partly understood.
Schema-only analysis has constraints and indexes but no live cardinality statistics.

Pair raw `EXPLAIN (FORMAT JSON)` output with schema metadata:

```bash
sqlsage analyze \
  --query query.sql \
  --catalog catalog.json \
  --plan plan.json
```

If a saved SQLSage evidence bundle contains its catalog, `--plan` can be used without
a second metadata flag. Bundles that contain SQL must match the query being analyzed;
SQLSage refuses mismatched evidence.

Plan-aware JSON output is itself reusable:

```bash
sqlsage analyze --query query.sql --catalog catalog.json --plan plan.json \
  --format json > evidence.json
sqlsage analyze --query query.sql --plan evidence.json
```

## Live PostgreSQL workflow

Connected mode introspects one schema and collects a non-executing plan by default:

```bash
sqlsage analyze \
  --query query.sql \
  --database-url "$DATABASE_URL" \
  --schema-name public
```

This runs `EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON)` inside a read-only transaction
with a transaction-local statement timeout, then rolls back. M1 schema binding must
succeed before PostgreSQL receives EXPLAIN.

Execution is opt-in:

```bash
sqlsage analyze \
  --query query.sql \
  --database-url "$DATABASE_URL" \
  --schema-name public \
  --analyze \
  --statement-timeout 5000
```

`--analyze` runs one `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)`
inside the same read-only, timed, rollback-contained boundary. It executes the
`SELECT`. Read-only mode prevents database writes, but it cannot prevent external
side effects inside an unfamiliar user-defined volatile function; review the query
before opting in.

## Evidence labels

SQLSage keeps these states separate:

- **Predicted and unverified:** structural/catalog reasoning without an observed plan.
- **Plan-observed:** PostgreSQL chose the displayed plan, but the query was not run.
- **Measured baseline:** an explicitly opted-in or saved analyzed plan supplied one
  baseline runtime; proposed changes remain unmeasured.
- **Unverified:** candidate DDL, rewrite equivalence, and speed effects still require
  testing unless separate before/after evidence establishes them.

SQLSage does not turn one baseline timing into a promised speedup and does not invent
an optimized plan or result-equivalence verdict.

## Catalog JSON

A minimal catalog looks like:

```json
{
  "dialect": "postgres",
  "serverVersion": "16",
  "tables": [
    {
      "schema": "public",
      "name": "orders",
      "columns": [
        { "name": "order_id", "dataType": "bigint", "nullable": false },
        { "name": "created_at", "dataType": "timestamp with time zone", "nullable": false }
      ],
      "primaryKey": ["order_id"],
      "indexes": []
    }
  ]
}
```

Live catalogs can also include row counts, sizes, column statistics, planner settings,
foreign keys, and existing index metadata. User JSON is validated at runtime.

## Exit codes

- `0`: analysis completed and output was written. Findings are product output, not a
  process failure.
- `1`: usage, input, catalog/schema/plan, connection, EXPLAIN, or output failure.
- `2`: SQL could not be parsed/bound safely, is outside the supported `SELECT` scope,
  or the analysis pipeline was incomplete.

Ordinary input mistakes produce concise diagnostics without stack traces.

## Development verification

```bash
npm test
node eval/dump-ir.ts --check
node eval/run.ts
npm run build
npm run test:install
```

The twelve-query acceptance corpus covers nullable `NOT IN`, aggregate fan-out,
demoted outer joins, non-sargable timestamp filters, deep pagination, repeated
correlated work, JSON extraction, and a PostgreSQL 16 HAVING-pushdown false-positive
trap. Production rules do not import query IDs or stored ground-truth answers.

## Current limitations

- PostgreSQL `SELECT` is the supported statement family for this release.
- The schema importer deliberately rejects `ALTER TABLE`, generated columns,
  partitioning, table-level `CHECK`/`UNIQUE`, dollar-quoted SQL, and custom index
  storage options.
- One live schema is introspected per invocation; cross-schema queries need metadata
  for every referenced relation and may therefore be rejected.
- A statement timeout bounds PostgreSQL planning/execution, not DNS or TCP connection
  establishment.
- Offline predictions cannot prove exact join order, parallelism, spills, buffers,
  runtime, or speedup.
- Business-intent choices—especially outer-join population—remain human decisions.

See [`docs/CLI-FIRST-PLAN.md`](docs/CLI-FIRST-PLAN.md) for the product contract and
release gates.
