# Usage and inputs

## Query sources

Choose exactly one:

```text
--query query.sql
--sql "SELECT ..."
- or piped stdin
```

The current release supports one PostgreSQL `SELECT` statement per invocation.

## Metadata sources

Choose one primary source:

- `--catalog catalog.json`: SQLSage's lossless catalog format;
- `--schema schema.sql`: the supported PostgreSQL DDL subset; or
- `--database-url URL`: live introspection plus plan collection.

`--plan plan.json` may supplement catalog or schema metadata. A SQLSage evidence bundle
can embed its catalog and therefore be replayed without a separate metadata flag.

## Schema SQL support

Supported constructs include schemas, search paths, tables, column nullability,
primary/foreign keys, and common btree/hash/GIN/GiST/BRIN/SP-GiST indexes with supported
expressions, `INCLUDE`, and predicates.

The importer deliberately rejects unsupported constructs such as `ALTER TABLE`,
partitioning, generated columns, table-level `CHECK`/`UNIQUE`, dollar-quoted SQL, and
custom index storage options.

## Plan inputs

Accepted plan shapes include:

- PostgreSQL's one-element `EXPLAIN (FORMAT JSON)` array;
- a document containing a top-level `Plan`; and
- a SQLSage evidence bundle containing `planJson`, SQL, and optionally catalog metadata.

Plan-only files are labeled plan-observed. Files with actual rows/timing are labeled as
an analyzed baseline. Neither state verifies proposed changes.

## Output formats

```text
--format text
--format markdown
--format json
```

The default is terminal text on a TTY and Markdown when redirected. Use `--no-color` to
disable terminal styling.

## Live options

```text
--schema-name public
--statement-timeout 30000
--analyze
```

Default connected mode plans without executing the query. `--analyze` explicitly opts
into execution under `EXPLAIN ANALYZE`.
