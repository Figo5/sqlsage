import test from 'node:test';
import assert from 'node:assert/strict';

import { CliUsageError, parseCliArgs } from './cli-args.ts';

test('help, version, and list commands are side-effect free', () => {
  assert.deepEqual(parseCliArgs([], true), { command: 'help' });
  assert.deepEqual(parseCliArgs(['--help']), { command: 'help' });
  assert.deepEqual(parseCliArgs(['--version']), { command: 'version' });
  assert.deepEqual(parseCliArgs(['list']), { command: 'list' });
});

test('analyze accepts file, inline, explicit stdin, and piped stdin query sources', () => {
  assert.equal(parseCliArgs(['analyze', '--query', 'query.sql', '--catalog', 'catalog.json']).command, 'analyze');
  assert.deepEqual(
    parseCliArgs(['analyze', '--query', 'query.sql', '--catalog', 'catalog.json']).query,
    { kind: 'file', path: 'query.sql' },
  );
  assert.deepEqual(
    parseCliArgs(['analyze', '--sql', 'SELECT 1', '--schema', 'schema.sql']).query,
    { kind: 'inline', sql: 'SELECT 1' },
  );
  assert.deepEqual(
    parseCliArgs(['analyze', '-', '--catalog', 'catalog.json']).query,
    { kind: 'stdin' },
  );
  assert.deepEqual(
    parseCliArgs(['analyze', '--catalog', 'catalog.json'], false).query,
    { kind: 'stdin' },
  );
});

test('format, timeout, connection safety, and color options are validated', () => {
  const options = parseCliArgs([
    'analyze', '--sql', 'SELECT 1', '--database-url', 'postgres://localhost/db',
    '--schema-name', 'app', '--format', 'json', '--statement-timeout', '2500',
    '--analyze', '--no-color',
  ]);
  assert.equal(options.command, 'analyze');
  assert.equal(options.databaseUrl, 'postgres://localhost/db');
  assert.equal(options.schemaName, 'app');
  assert.equal(options.format, 'json');
  assert.equal(options.statementTimeoutMs, 2500);
  assert.equal(options.runAnalyze, true);
  assert.equal(options.color, false);
});

test('invalid and ambiguous invocations fail with concise usage errors', () => {
  const cases = [
    ['analyze', '--sql', 'SELECT 1'],
    ['analyze', '--sql'],
    ['analyze', '--wat', 'x'],
    ['analyze', '--sql', 'SELECT 1', '--query', 'q.sql', '--catalog', 'c.json'],
    ['analyze', '--sql', 'SELECT 1', '--catalog', 'c.json', '--schema', 's.sql'],
    ['analyze', '--sql', 'SELECT 1', '--catalog', 'c.json', '--format', 'xml'],
    ['analyze', '--sql', 'SELECT 1', '--catalog', 'c.json', '--statement-timeout', '0'],
    ['analyze', '--sql', 'SELECT 1', '--catalog', 'c.json', '--statement-timeout', '5000'],
    ['analyze', '--sql', 'SELECT 1', '--catalog', 'c.json', '--analyze'],
    ['analyze', '--sql', 'SELECT 1', '--catalog', 'c.json', '--schema-name', 'app'],
    ['analyze', '--sql', 'SELECT 1', '--database-url', 'postgres://db/app', '--plan', 'plan.json'],
  ];
  for (const args of cases) {
    assert.throws(() => parseCliArgs(args), CliUsageError, args.join(' '));
  }
});

test('corpus remains an explicit demo query source with bundled metadata available later', () => {
  const options = parseCliArgs(['analyze', '--corpus', 'q05', '--format', 'text']);
  assert.equal(options.command, 'analyze');
  assert.deepEqual(options.query, { kind: 'corpus', id: 'q05' });
});

test('demo takes no input, and says what to run instead of ignoring the flag', () => {
  assert.deepEqual(parseCliArgs(['demo']), { command: 'demo', format: undefined, color: undefined });
  assert.deepEqual(parseCliArgs(['demo', '--format', 'json']), { command: 'demo', format: 'json', color: undefined });
  assert.deepEqual(parseCliArgs(['demo', '--no-color']), { command: 'demo', format: undefined, color: false });

  // Silently ignoring an input flag would teach the wrong model on a first run.
  assert.throws(() => parseCliArgs(['demo', '--catalog', 'c.json']), (error: CliUsageError) => {
    assert.match(error.message, /demo takes no input flags/);
    assert.match(error.message, /sqlsage analyze --sql/);
    return true;
  });
  assert.throws(() => parseCliArgs(['demo', 'extra']), /demo takes no arguments/);
  assert.throws(() => parseCliArgs(['demo', '--format', 'yaml']), /--format must be text, markdown, or json/);
});

test('doctor accepts metadata flags, requires none, and refuses to execute anything', () => {
  assert.deepEqual(parseCliArgs(['doctor']), {
    command: 'doctor',
    catalogPath: undefined,
    schemaPath: undefined,
    planPath: undefined,
    databaseUrl: undefined,
    schemaName: 'public',
    statementTimeoutMs: 30_000,
    color: undefined,
  });

  const full = parseCliArgs(['doctor', '--catalog', 'c.json', '--schema-name', 'shop', '--database-url', 'postgres://x']);
  assert.equal(full.command, 'doctor');
  assert.equal(full.command === 'doctor' && full.catalogPath, 'c.json');
  assert.equal(full.command === 'doctor' && full.schemaName, 'shop');

  // --schema-name without --database-url is a usage error for analyze, but for
  // doctor it is meaningless rather than wrong, so it must not be rejected here.
  assert.equal(parseCliArgs(['doctor', '--schema-name', 'shop']).command, 'doctor');

  assert.throws(() => parseCliArgs(['doctor', '--analyze']), /doctor never runs EXPLAIN ANALYZE/);
  assert.throws(() => parseCliArgs(['doctor', '--sql', 'SELECT 1']), /doctor does not take --sql/);
  assert.throws(() => parseCliArgs(['doctor', 'file.sql']), /doctor takes no positional arguments/);
});

test('compare takes two captured plans and refuses to run anything', () => {
  assert.deepEqual(parseCliArgs(['compare', '--before', 'a.json', '--after', 'b.json']), {
    command: 'compare', beforePath: 'a.json', afterPath: 'b.json', format: undefined, color: undefined,
  });
  assert.equal(parseCliArgs(['compare', '--before', 'a', '--after', 'b', '--format', 'json']).format, 'json');

  assert.throws(() => parseCliArgs(['compare']), /needs both --before <plan> and --after <plan>/);
  assert.throws(() => parseCliArgs(['compare', '--before', 'a']), /needs both --before/);
  assert.throws(() => parseCliArgs(['compare', 'extra.json']), /takes no positional arguments/);
  // compare diffs captures; it never executes a query, so these are refused outright.
  assert.throws(() => parseCliArgs(['compare', '--before', 'a', '--after', 'b', '--analyze']), /never executes a query/);
  assert.throws(() => parseCliArgs(['compare', '--before', 'a', '--after', 'b', '--database-url', 'x']), /does not take --database-url/);
});
