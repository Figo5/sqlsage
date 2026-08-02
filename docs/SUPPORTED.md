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
| `ALTER TABLE` (ADD CONSTRAINT / ADD COLUMN / ALTER COLUMN SET-DROP NOT NULL) | supported |
| `UNIQUE` as a column or table constraint | supported |
| `CHECK` constraints | accepted; predicate not modelled |
| Generated and identity columns (`GENERATED ...`) | supported |
| Partitioned tables (`PARTITION BY`, `PARTITION OF`, `ATTACH PARTITION`) | supported |
| `CREATE VIEW`, `CREATE MATERIALIZED VIEW` | supported, with limits below |

### Uniqueness

Uniqueness is load-bearing for SQLSage: it is how the join analysis decides whether a
join multiplies rows, which drives correctness findings about over-counted aggregates.

All three spellings inside `CREATE TABLE` are understood and become unique indexes:

```sql
CREATE TABLE s.t (
  email text UNIQUE,                       -- column constraint
  a text, b text, UNIQUE (a, b),           -- table constraint, composite
  badge text CONSTRAINT badge_uq UNIQUE    -- named
);
CREATE UNIQUE INDEX i ON s.t (k);          -- and the explicit index form
```

`UNIQUE` does **not** imply `NOT NULL`. PostgreSQL treats NULLs as distinct, so a unique
column may hold many of them, and SQLSage leaves nullability exactly as declared.

`UNIQUE ... NULLS NOT DISTINCT` (PostgreSQL 15+) is rejected rather than parsed into a
plain unique index, because it asserts something different. `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE` is also supported.

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

### ALTER TABLE

Supported actions: `ADD [CONSTRAINT name] PRIMARY KEY | UNIQUE | FOREIGN KEY`,
`ADD [COLUMN] name type ...`, and `ALTER [COLUMN] name SET/DROP NOT NULL`. Several
actions may be comma-separated in one statement, and `ONLY` and `IF EXISTS` are accepted.

The table must already have been declared by a `CREATE TABLE` earlier in the file, so
statement order matters exactly as it does for PostgreSQL.

Actions that do not affect the analysis are **rejected rather than ignored**, because
accepting them silently would imply SQLSage modelled them: `DROP COLUMN`,
`DROP CONSTRAINT`, `SET DEFAULT`, type changes, and `ADD CHECK`.

### Real `pg_dump --schema-only` output

A dump parses directly. Statements carrying nothing the analysis reads are skipped:
`SET` parameters other than `search_path`, `SELECT pg_catalog.set_config(...)`,
`ALTER ... OWNER TO`, `GRANT`/`REVOKE`, `COMMENT ON`, sequences, extensions, types
(including enums), and functions, procedures and triggers — dollar-quoted bodies and all.

An enum-typed column keeps its type name as an opaque string, which is all the analysis
uses.

`CHECK` constraints are accepted but their predicates are **not modelled**. A CHECK cannot
change the column set, keys, indexes or nullability, so skipping it costs nothing.

`GENERATED ALWAYS AS IDENTITY` implies `NOT NULL`; `GENERATED ALWAYS AS (expr) STORED` is
an ordinary nullable column whose value happens to be computed.

**Skipping is an allowlist, not a catch-all.** Anything not named above still fails
loudly. A parser that quietly ignored what it did not understand would hand back a catalog
silently missing keys or indexes, and every downstream claim about uniqueness, nullability
and join fan-out would inherit that gap.

### Partitioned tables

Live introspection reports a partitioned parent's row count and size by summing its
partition tree, because the parent stores no rows of its own and would otherwise look
empty. When any partition has never been analyzed the count is reported as unknown rather
than as a misleading partial sum.

`PARTITION BY RANGE | LIST | HASH`, `CREATE TABLE ... PARTITION OF ...`, and the
`ALTER TABLE ... ATTACH PARTITION` form `pg_dump` emits all parse.

Each partition becomes a relation in its own right, carrying the parent's columns and the
primary key PostgreSQL materialises on every partition. That separation is deliberate: a
unique index declared on **one partition** is unique only within that partition, and
folding partitions into the parent would over-claim uniqueness.

SQLSage enforces PostgreSQL's own rule that a `PRIMARY KEY` or `UNIQUE` on a partitioned
table must include every partition key column, and that a table partitioned by an
*expression* may carry no unique constraint at all. Both are rejected rather than
accepted, because uniqueness is what the join fan-out proof reads: accepting a constraint
the server would refuse would make SQLSage assert a relation is unique when the real
database could hold duplicates.

Partition bounds and pruning are not modelled.

### Views and materialized views

`CREATE VIEW`, `CREATE OR REPLACE VIEW`, and `CREATE MATERIALIZED VIEW` parse. A view's
columns are resolved against the tables already declared in the file, so the relation it
selects from must appear first.

**No index is ever recommended for a plain view** — it has no storage, so the DDL would be
invalid. Materialized views are physical and are treated like tables for index advice.

**Nullability is inherited only for a single-source view projecting a column directly.**
Across a join, every view column is reported nullable, because an outer join, aggregate or
`CASE` can introduce NULLs the source column's declaration does not show. Over-claiming
`NOT NULL` would corrupt the null-rejection analysis; under-claiming only weakens a verdict.

A computed output column gets data type `unknown` and requires an `AS` alias to name it.

Rejected rather than guessed at, because a view whose columns cannot be resolved
faithfully is worse than no view at all: an unknown or ambiguous column, a subquery in
`FROM`, a set operation, and a CTE.

Live introspection (`--database-url`) sees views, materialized views and partitioned
tables too, so `--schema` and a live connection agree on which relations exist.

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
