# Supported SQL and schema constructs

What SQLSage accepts, what it rejects, and what it accepts but cannot reason about well.

Every entry below was **measured** against the current build rather than inferred from the
source. Re-derive it after changing the parser or the binder:

```bash
node eval/scope-probe.ts
```

SQLSage rejects what it does not understand instead of returning partial metadata. A
rejection is a deliberate answer, not a crash.

## Queries

SQLSage analyzes a single PostgreSQL **`SELECT`** statement.

| Construct | Status |
|---|---|
| `SELECT`, joins, subqueries, CTEs | supported |
| `LATERAL` and correlated derived tables | supported |
| Window functions | supported |
| `UNION` and other set operations | supported |
| `DISTINCT ON` | supported |
| `GROUP BY`, `HAVING`, `ORDER BY`, `LIMIT`/`OFFSET` | supported |
| Query parameters (`$1`, `$2`) | **binds, but analysis is weaker** — see below |
| `INSERT`, `UPDATE`, `DELETE` | parsed and then **refused** (exit code 2) |
| `WITH RECURSIVE` | **not supported** — binding error |
| `GROUPING SETS`, `CUBE`, `ROLLUP` | **not supported** — binding error |

Non-`SELECT` statements are recognized well enough to be named in the refusal, so you get
"only SELECT statements are supported; received insert" rather than a parse failure.

### Query parameters

A query containing `$1` binds without error, so SQLSage will produce a report. Treat that
report with care: a placeholder has no value, so selectivity and index advice for a
predicate on `$1` rest on defaults rather than on your data. Substituting a representative
literal generally yields better advice. Improving this is on the roadmap.

## Schema SQL (`--schema`)

| Construct | Status |
|---|---|
| `CREATE SCHEMA`, `SET search_path` | supported |
| `CREATE TABLE` with column types and `NOT NULL` | supported |
| `PRIMARY KEY`, `FOREIGN KEY` / `REFERENCES` | supported |
| **Multiple schemas in one file, including cross-schema FKs** | **supported** |
| `CREATE INDEX`, including `UNIQUE` | supported |
| Partial indexes (`WHERE ...`) | supported |
| Expression indexes (`lower(v)`) | supported |
| Covering indexes (`INCLUDE (...)`) | supported |
| Non-btree access methods (`USING gin`, etc.) | supported |
| `ALTER TABLE` | **not supported** |
| `UNIQUE` as a column or table constraint | **not supported** — see below |
| `CHECK` constraints | **not supported** |
| Generated and identity columns (`GENERATED ...`) | **not supported** |
| Partitioned tables (`PARTITION BY`) | **not supported** |
| `CREATE VIEW`, `CREATE MATERIALIZED VIEW` | **not supported** |

### Uniqueness is supported, but only spelled as an index

This distinction matters more than it looks. Uniqueness is load-bearing for SQLSage: it is
how the join analysis decides whether a join multiplies rows, which is what drives
correctness findings about over-counted aggregates.

`CREATE UNIQUE INDEX i ON shop.t (k)` is understood. `UNIQUE` written as a column or table
constraint is not, and neither is `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`. If your
schema declares uniqueness that way, SQLSage will reject the file rather than quietly
treat the column as non-unique — but you can express the same fact as a unique index.

### Working around an unsupported construct

Two options, in order of preference:

1. **Use `--catalog` instead of `--schema`.** The SQLSage catalog JSON is the richer input
   and does not go through the DDL parser. `sqlsage doctor --catalog catalog.json`
   validates it.
2. **Reduce the DDL to what the analysis needs** — tables, column types, nullability, keys,
   and indexes. `CHECK` constraints and views do not affect the current analysis, so
   removing them costs nothing.

Generating a catalog from a live database avoids the question entirely:

```bash
sqlsage analyze --query q.sql --database-url "$DATABASE_URL" --schema-name public
```

## Plan inputs (`--plan`)

Accepts raw `EXPLAIN (FORMAT JSON)` output and SQLSage evidence bundles. A bundle carrying
SQL must match the query being analyzed; mismatched evidence is rejected rather than
silently trusted. Validate one with `sqlsage doctor --plan plan.json`.

## Checking your own inputs

`sqlsage doctor` answers these questions for a specific file instead of in general, and
prints the exact corrective command on failure:

```bash
sqlsage doctor --catalog catalog.json --schema schema.sql --plan plan.json
```

## Related

- [Usage and inputs](USAGE.md) — the full input contract
- [Architecture](ARCHITECTURE.md) — the analysis pipeline
