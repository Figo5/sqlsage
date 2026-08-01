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
