# Live PostgreSQL evidence boundary

`collectLiveEvidence()` is the Milestone-3 integration point for a caller that has already parsed and bound one query. It accepts a database URL, SQL, one schema name, an optional positive statement timeout, and an explicit `analyze` opt-in. It returns the catalog from the existing `introspect()` implementation plus the single PostgreSQL JSON plan payload.

## Exact database sequence

Both default and analyzed modes use one client and one transaction:

1. connect;
2. `BEGIN`;
3. `SET TRANSACTION READ ONLY`;
4. validated `SET LOCAL statement_timeout = '<positive integer>ms'`;
5. introspect exactly one schema;
6. run exactly one EXPLAIN;
7. `ROLLBACK` in `finally`;
8. end the client.

Default mode issues `EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON)` and therefore plans without executing the statement. Only `analyze: true` issues `EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON)`.

Before creating a client, the boundary independently checks that SQL parses as exactly one read-only SELECT/VALUES/UNION statement and contains no data-modifying CTE. After catalog introspection, it also runs SQLSage's M1 schema binder and refuses to send EXPLAIN when hard binding errors remain. A second statement cannot escape the EXPLAIN prefix, and DDL/DML is never sent. Schema names go only to parameterized catalog introspection; the timeout is the sole interpolated value and is first constrained to a positive safe integer.

## Dependency injection

Tests and future embedders can provide `LiveDependencies.createClient` and `LiveDependencies.introspect`. The production defaults construct `pg.Client({ connectionString: databaseUrl })` and call the existing catalog `introspect(client, schema)`.

## Limits

- `EXPLAIN ANALYZE` executes the SELECT. Read-only mode prevents database writes, but PostgreSQL cannot make arbitrary user-defined functions free of external side effects. The CLI must keep this an explicit opt-in and should display that warning.
- A statement timeout bounds PostgreSQL execution time, not DNS/TCP connection establishment. Connection timeout policy remains the connection URL/`pg` configuration's responsibility.
- One schema is introspected. Cross-schema references can still appear in SQL, but their metadata will not be present unless the caller chooses the relevant schema or the catalog contract grows multi-schema collection.
- The returned `planJson` is PostgreSQL's raw `QUERY PLAN` value. This module does not infer plan changes, measure multiple runs, compare results, execute recommendations, or persist credentials/plans.
- Rollback and client shutdown are always attempted after the transaction starts. If EXPLAIN/introspection already failed, that original error is preserved even if cleanup also fails.
