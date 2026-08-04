# CLI Reference

## Commands

| Command | Description |
|---|---|
| `sqlsage analyze` | Analyze a single PostgreSQL `SELECT` statement (the default command). |
| `sqlsage demo` | Analyze the bundled `q05` example. Takes no input; needs no files or database. |
| `sqlsage doctor` | Validate the runtime, bundled assets, input files, and optionally a live connection. Read-only. |
| `sqlsage compare` | Diff two captured plans and report what changed and whether it measurably improved. Never executes a query. |
| `sqlsage list` | List the bundled example queries (`id` and title). |
| `sqlsage --help` / `-h` | Print usage. |
| `sqlsage --version` / `-V` | Print the installed version. |

Usage:

```text
sqlsage analyze --query query.sql --catalog catalog.json
sqlsage analyze --sql "SELECT ..." --catalog catalog.json
cat query.sql | sqlsage analyze --catalog catalog.json
```

## `analyze` flags

### Query source — choose exactly one

| Flag | Description |
|---|---|
| `--query`, `-q <file|->` | SQL file, or `-` for stdin. |
| `--sql <statement>` | Inline SQL. |
| `--corpus <id>` | A bundled example query (see [`sqlsage list`](/examples)). Prefixes are accepted when unambiguous. |
| *positional* | A `.sql` file path, inline SQL, or `-` for stdin. |

### Metadata — choose one primary source

| Flag | Description |
|---|---|
| `--catalog <file>` | SQLSage catalog JSON. |
| `--schema <file>` | PostgreSQL `CREATE TABLE`/`INDEX` schema SQL. |
| `--database-url <url>` | Live catalog plus PostgreSQL plan evidence. |
| `--plan <file>` | *Supplementary.* Saved PostgreSQL JSON plan or a SQLSage evidence bundle. |

`--plan` may supplement catalog or schema metadata. A SQLSage evidence bundle can
embed its catalog and therefore be replayed without a separate metadata flag. If a
bundle contains SQL, it must match the query being analyzed — mismatched evidence is
rejected.

### Output and safety

| Flag | Description |
|---|---|
| `--format`, `-f <format>` | `text`, `markdown`, or `json`. Default: terminal text on a TTY, Markdown when redirected. |
| `--no-color` | Disable ANSI styling in text output. |
| `--statement-timeout <ms>` | Live database timeout. Default `30000`. Requires `--database-url`. |
| `--analyze` | Opt in to read-only `EXPLAIN ANALYZE`. Requires `--database-url`. |
| `--schema-name <name>` | Live database schema. Default `public`. Requires `--database-url`. |

::: warning Safety
`--analyze` **executes the SELECT**. A read-only transaction cannot prevent external
side effects inside an unfamiliar user-defined volatile function — review the query
before opting in. SQLSage never executes recommended rewrites or candidate index DDL.
:::

## `doctor` flags

`doctor` accepts the same metadata flags as `analyze` but requires none of them. With
no flags it checks the runtime and bundled assets; each flag supplied adds the
corresponding check. It rejects `--analyze` and query-source flags.

| Flag | Adds this check |
|---|---|
| `--catalog <file>` | Validate a catalog file. |
| `--schema <file>` | Validate a schema file. |
| `--plan <file>` | Validate a saved plan or evidence bundle. |
| `--database-url <url>` | Server version, auth, `EXPLAIN` in a read-only transaction, schema visibility, table read permission, planner statistics. |
| `--schema-name <name>` | Live schema name (default `public`). |
| `--statement-timeout <ms>` | Live database timeout (default `30000`). |

## `compare` flags

`compare` diffs two captured plans; it never runs a query itself.

| Flag | Description |
|---|---|
| `--before <file>` | The earlier captured plan (required). |
| `--after <file>` | The later captured plan (required). |
| `--format`, `-f <format>` | `text`, `markdown`, or `json`. |

It refuses verdicts the evidence cannot support: no timing comparison when either side
is plan-only, no "improvement" claimed below 1.2x (two single runs cannot separate
that from noise), and a prominent flag when the two captures describe different
statements.

## Evidence labels

Every claim in an analysis carries an evidence level:

| Label | Meaning |
|---|---|
| **Predicted / unverified** | Derived offline from query structure and catalog statistics. |
| **Plan-observed** | Established by a captured `EXPLAIN` — planner choices, not runtime. |
| **Measured baseline** | Established by `EXPLAIN ANALYZE` — one measurement, not a promised improvement. |

Candidate rewrites, DDL, and speed effects remain unverified until separately tested.

## Exit codes

- `0` — analysis completed and output was written;
- `1` — usage, input, connection, plan, or output failure;
- `2` — unsupported, unparseable, unbound, or incomplete analysis.

Findings do not make the process fail; they are the product output.
