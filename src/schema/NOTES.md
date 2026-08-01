# Offline schema importer

`parseSchemaCatalog()` is deliberately a schema-shape parser, not a PostgreSQL
DDL executor. It recognizes `CREATE SCHEMA`, `SET search_path`, `CREATE TABLE`,
primary/foreign keys, and ordinary `CREATE INDEX` statements. Primary keys
synthesize the unique btree indexes PostgreSQL creates implicitly.

The importer does not invent row counts, column statistics, relation sizes,
server versions, or planner settings. Advice from a schema-only catalog must
therefore remain prediction-based until a saved plan or live connection adds
observed evidence.

## Fail-closed limits

- `ALTER TABLE`, partitioning/inheritance, generated/identity columns, CHECK and
  UNIQUE constraints, exclusion constraints, and custom index storage options
  are rejected rather than partially imported.
- Dollar-quoted SQL (typically functions or procedures) is rejected.
- Supported index methods are the methods represented by SQLSage's shared
  `IndexDef`: btree, hash, gin, gist, brin, and spgist.
- Expression and partial-index SQL is retained structurally but is not executed
  or type-checked offline.
- Live statistics and size fields are unavailable by design.

The corpus schema imports as six `shop` tables and eight persistent indexes
(six primary-key indexes plus two explicit FK-supporting indexes), and all 12
corpus queries bind without hard errors against that catalog.
