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
primary/foreign keys, column and table `UNIQUE` constraints, and common
btree/hash/GIN/GiST/BRIN/SP-GiST indexes with supported expressions, `INCLUDE`, and
predicates.

`ALTER TABLE` supports adding columns and primary/unique/foreign-key constraints,
adding `CHECK` constraints, and setting or dropping column `NOT NULL`. The table must
already be declared in the file. `CHECK` predicates are accepted but are not modelled.
Identity columns imply `NOT NULL`; stored generated columns retain their declared
nullability, and their expressions are not modelled.

Declarative partition forms (`PARTITION BY RANGE/LIST/HASH`, `PARTITION OF`, and
`ATTACH PARTITION`) are accepted, but bounds and pruning are not modelled. Views and
materialized views are accepted when their columns can be resolved from relations
already declared in the file; view definitions using CTEs, set operations, or subqueries
in `FROM` are rejected.

Common `pg_dump --schema-only` preambles, ownership, permissions, comments, sequences,
extensions, types, and routine definitions are skipped, including dollar-quoted routine
bodies and the `\restrict`/`\unrestrict` wrappers. This does not provide general
support for arbitrary dollar-quoted SQL. File-inclusion commands such as `\i` and
`\ir` are rejected; concatenate those files first.

Other rejected constructs include `DROP COLUMN`/`DROP CONSTRAINT`, column type and
default changes, `INHERITS`, `EXCLUDE`, `UNIQUE ... NULLS NOT DISTINCT`, virtual
generated columns, and custom index storage options. `CREATE INDEX CONCURRENTLY` and
`CREATE INDEX ... ON ONLY` are also rejected, so some schema dumps need reduction or a
catalog instead. See [Supported constructs](SUPPORTED.md) for the detailed limits.

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
