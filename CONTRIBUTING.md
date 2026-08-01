# Contributing to SQLSage

Thank you for helping improve SQLSage.

## Development setup

Requirements: Node.js 24 or newer, npm, and optionally PostgreSQL 16+ for live tests.

```bash
git clone https://github.com/Figo5/sqlsage.git
cd sqlsage
npm ci
npm run check
```

## Pull requests

Keep changes focused and include tests that exercise the user-visible behavior. For an
analysis rule, include both a positive case and a counterexample that must not be
flagged. Production rules must reason from the parsed query, catalog, and plan evidence;
they must not recognize bundled corpus IDs or exact fixture SQL.

Before opening a pull request, run:

```bash
npm run check
npm run test:install
```

Changes that recommend SQL or index DDL must preserve the existing safety boundaries:

- never execute recommendations;
- distinguish equivalent, conditional, and result-changing rewrites;
- keep rewrite/index dependencies explicit;
- label predicted, observed, and measured evidence accurately; and
- reject unsupported input rather than guessing.

## Live integration test

The standard suite does not require PostgreSQL. To run the opt-in live check against a
compatible test database:

```bash
SQLSAGE_LIVE_TEST=1 \
SQLSAGE_TEST_DATABASE_URL="postgresql://postgres:password@127.0.0.1:55432/sage" \
node --test src/live.integration.test.ts
```

Never point development tests at a database containing irreplaceable data.
