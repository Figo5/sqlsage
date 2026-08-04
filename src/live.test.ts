import assert from 'node:assert/strict';
import test from 'node:test';

import type { Catalog } from './types.ts';
import {
  collectLiveEvidence,
  DEFAULT_LIVE_STATEMENT_TIMEOUT_MS,
  LiveInputError,
} from './live.ts';
import type { LiveClient, LiveDependencies, LiveQueryResult } from './live.ts';

const CATALOG: Catalog = {
  dialect: 'postgres',
  serverVersion: '16.test',
  tables: [{
    schema: 'tenant',
    name: 'accounts',
    columns: [
      { name: 'account_id', dataType: 'bigint', nullable: false },
      { name: 'state', dataType: 'text', nullable: false },
    ],
    primaryKey: ['account_id'],
    indexes: [],
  }],
};

interface FakeOptions {
  failConnect?: Error;
  failExplain?: Error;
  failRollback?: Error;
}

function fakeHarness(options: FakeOptions = {}): {
  events: string[];
  dependencies: LiveDependencies;
} {
  const events: string[] = [];
  const client: LiveClient = {
    async connect() {
      events.push('connect');
      if (options.failConnect) throw options.failConnect;
    },
    async query(text: string, values?: unknown[]): Promise<LiveQueryResult> {
      events.push(`query:${text}${values ? ` values=${JSON.stringify(values)}` : ''}`);
      if (text.startsWith('EXPLAIN ')) {
        if (options.failExplain) throw options.failExplain;
        return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result' } }] }] };
      }
      if (text === 'ROLLBACK' && options.failRollback) throw options.failRollback;
      return { rows: [] };
    },
    async end() {
      events.push('end');
    },
  };
  return {
    events,
    dependencies: {
      createClient(databaseUrl) {
        events.push(`factory:${databaseUrl}`);
        return client;
      },
      async introspect(received, schema) {
        assert.equal(received, client);
        events.push(`introspect:${schema}`);
        return CATALOG;
      },
    },
  };
}

test('default mode introspects one schema and captures one non-executing JSON EXPLAIN', async () => {
  const { events, dependencies } = fakeHarness();
  const sql = "SELECT account_id FROM tenant.accounts WHERE state = 'open'";
  const evidence = await collectLiveEvidence({
    databaseUrl: 'postgresql://reader:secret@db.example/app',
    sql,
    schema: 'tenant',
  }, dependencies);

  assert.deepEqual(events, [
    'factory:postgresql://reader:secret@db.example/app',
    'connect',
    'query:BEGIN',
    'query:SET TRANSACTION READ ONLY',
    `query:SET LOCAL statement_timeout = '${DEFAULT_LIVE_STATEMENT_TIMEOUT_MS}ms'`,
    'introspect:tenant',
    `query:EXPLAIN (VERBOSE, SETTINGS, FORMAT JSON) ${sql}`,
    'query:ROLLBACK',
    'end',
  ]);
  assert.equal(evidence.catalog, CATALOG);
  assert.deepEqual(evidence.planJson, [{ Plan: { 'Node Type': 'Result' } }]);
  assert.equal(evidence.mode, 'estimated');
  assert.equal(evidence.schema, 'tenant');
  assert.equal(evidence.statementTimeoutMs, DEFAULT_LIVE_STATEMENT_TIMEOUT_MS);

  const explainEvents = events.filter((event) => event.startsWith('query:EXPLAIN'));
  assert.equal(explainEvents.length, 1);
  assert.doesNotMatch(explainEvents[0], /ANALYZE|BUFFERS/);
  assert.equal(events.filter((event) => event.includes(sql)).length, 1);
  assert.ok(events.find((event) => event.includes(sql))?.startsWith('query:EXPLAIN'));
});

test('analyze is explicit and remains read-only, timeout-bounded, and rollback-contained', async () => {
  const { events, dependencies } = fakeHarness();
  const sql = 'WITH ids AS (SELECT 1 AS id) SELECT id FROM ids';
  const evidence = await collectLiveEvidence({
    databaseUrl: 'postgres://localhost/example',
    sql,
    schema: ' public ',
    analyze: true,
    statementTimeoutMs: 2750,
  }, dependencies);

  assert.deepEqual(events, [
    'factory:postgres://localhost/example',
    'connect',
    'query:BEGIN',
    'query:SET TRANSACTION READ ONLY',
    "query:SET LOCAL statement_timeout = '2750ms'",
    'introspect:public',
    `query:EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) ${sql}`,
    'query:ROLLBACK',
    'end',
  ]);
  assert.equal(evidence.mode, 'analyzed');
  assert.equal(evidence.statementTimeoutMs, 2750);
});

test('EXPLAIN failure still rolls back and ends the client, preserving the database error', async () => {
  const failure = new Error('statement timeout');
  const { events, dependencies } = fakeHarness({ failExplain: failure });
  await assert.rejects(
    collectLiveEvidence({
      databaseUrl: 'postgres://localhost/example',
      sql: 'SELECT expensive_function()',
      analyze: true,
    }, dependencies),
    (error) => error === failure,
  );
  assert.deepEqual(events.slice(-3), [
    'query:EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS, FORMAT JSON) SELECT expensive_function()',
    'query:ROLLBACK',
    'end',
  ]);
});

test('schema binding happens after introspection and before any EXPLAIN', async () => {
  const { events, dependencies } = fakeHarness();
  await assert.rejects(
    collectLiveEvidence({
      databaseUrl: 'postgres://localhost/example',
      sql: 'SELECT missing_column FROM tenant.accounts',
      analyze: true,
    }, dependencies),
    (error) => error instanceof LiveInputError && /blocked by schema binding/.test(error.message),
  );
  assert.equal(events.some((event) => event.startsWith('query:EXPLAIN')), false);
  assert.deepEqual(events.slice(-2), ['query:ROLLBACK', 'end']);
});

test('client end is attempted even when connection setup fails', async () => {
  const failure = new Error('connection refused');
  const { events, dependencies } = fakeHarness({ failConnect: failure });
  await assert.rejects(
    collectLiveEvidence({ databaseUrl: 'postgres://localhost/example', sql: 'SELECT 1' }, dependencies),
    (error) => error === failure,
  );
  assert.deepEqual(events, ['factory:postgres://localhost/example', 'connect', 'end']);
});

test('rollback failure is surfaced after a successful capture and the client still ends', async () => {
  const failure = new Error('rollback failed');
  const { events, dependencies } = fakeHarness({ failRollback: failure });
  await assert.rejects(
    collectLiveEvidence({ databaseUrl: 'postgres://localhost/example', sql: 'SELECT 1' }, dependencies),
    (error) => error === failure,
  );
  assert.deepEqual(events.slice(-2), ['query:ROLLBACK', 'end']);
});

test('input validation is concise, typed, and happens before a client is created', async () => {
  let clients = 0;
  const dependencies: LiveDependencies = {
    createClient() {
      clients++;
      throw new Error('must not create a client');
    },
  };
  const cases: Array<[string, Parameters<typeof collectLiveEvidence>[0], RegExp]> = [
    ['database URL', { databaseUrl: ' ', sql: 'SELECT 1' }, /^database URL is required\.$/],
    ['blank schema', { databaseUrl: 'postgres://db/app', sql: 'SELECT 1', schema: '  ' }, /^schema must be a nonblank/],
    ['NUL schema', { databaseUrl: 'postgres://db/app', sql: 'SELECT 1', schema: 'app\0evil' }, /^schema must be a nonblank/],
    ['zero timeout', { databaseUrl: 'postgres://db/app', sql: 'SELECT 1', statementTimeoutMs: 0 }, /^statement timeout must be a positive/],
    ['negative timeout', { databaseUrl: 'postgres://db/app', sql: 'SELECT 1', statementTimeoutMs: -1 }, /^statement timeout must be a positive/],
    ['fractional timeout', { databaseUrl: 'postgres://db/app', sql: 'SELECT 1', statementTimeoutMs: 1.5 }, /^statement timeout must be a positive/],
    ['blank SQL', { databaseUrl: 'postgres://db/app', sql: ' ' }, /^live SQL must be a nonblank/],
    ['multiple statements', { databaseUrl: 'postgres://db/app', sql: 'SELECT 1; SELECT 2' }, /^live SQL must contain exactly one/],
    ['DML', { databaseUrl: 'postgres://db/app', sql: 'DELETE FROM accounts' }, /^live SQL must be a read-only SELECT/],
    ['DDL', { databaseUrl: 'postgres://db/app', sql: 'DROP TABLE accounts' }, /^live SQL must be a read-only SELECT/],
    ['data-modifying CTE', {
      databaseUrl: 'postgres://db/app',
      sql: 'WITH removed AS (DELETE FROM accounts RETURNING *) SELECT * FROM removed',
    }, /^live SQL must be a read-only SELECT/],
  ];

  for (const [label, input, message] of cases) {
    await assert.rejects(
      collectLiveEvidence(input, dependencies),
      (error) => {
        assert.ok(error instanceof LiveInputError, label);
        assert.match(error.message, message, label);
        assert.ok(error.message.length < 90, label);
        return true;
      },
    );
  }
  assert.equal(clients, 0);
});

test('the client factory receives the statement timeout so it can bound itself', async () => {
  // `SET LOCAL statement_timeout` is a server setting and cannot bound the
  // client's own wait. Without a client-side bound, an unreachable host hangs
  // the process with no output. The factory needs the timeout to derive one.
  let seen: number | undefined;
  await collectLiveEvidence(
    { databaseUrl: 'postgres://u@h/db', sql: 'SELECT 1', statementTimeoutMs: 7_000 },
    {
      createClient(_databaseUrl, statementTimeoutMs) {
        seen = statementTimeoutMs;
        return {
          async connect() {},
          async query() { return { rows: [{ 'QUERY PLAN': [{ Plan: {} }] }] }; },
          async end() {},
        };
      },
      async introspect() { return CATALOG; },
    },
  );
  assert.equal(seen, 7_000);
});
