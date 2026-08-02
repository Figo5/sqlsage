import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';

import { CORPUS } from '../corpus/queries.ts';
import { collectLiveEvidence } from './live.ts';
import { normalizePlanEvidence } from './plan-evidence.ts';

const enabled = process.env.SQLSAGE_LIVE_TEST === '1';
const databaseUrl = process.env.SQLSAGE_TEST_DATABASE_URL ??
  'postgresql://postgres:sage@127.0.0.1:55432/sage';

test('live default captures a plan without changing the shop schema', { skip: !enabled }, async () => {
  const query = CORPUS.find((candidate) => candidate.id.startsWith('q10'))!;
  const evidence = await collectLiveEvidence({
    databaseUrl,
    sql: query.sql,
    schema: 'shop',
    analyze: false,
    statementTimeoutMs: 5_000,
  });
  const plan = normalizePlanEvidence(evidence.planJson);
  assert.equal(evidence.mode, 'estimated');
  assert.equal(plan.mode, 'plan-only');
  assert.equal(plan.summary.accessPaths.some((path) => path.relation === 'orders'), true);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const count = await client.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = 'shop'`);
    assert.equal(count.rows[0].n, 8);
  } finally {
    await client.end();
  }
});

test('introspection sees views, materialized views and partitioned tables', { skip: !enabled }, async () => {
  const { introspect, validateCatalog } = await import('./catalog.ts');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    // Everything happens inside a transaction that is always rolled back, so the
    // shop schema and its eight baseline indexes are never touched.
    await client.query('BEGIN');
    await client.query(`
      CREATE SCHEMA probe;
      CREATE TABLE probe.parent (id bigint, d date NOT NULL) PARTITION BY RANGE (d);
      CREATE TABLE probe.p1 PARTITION OF probe.parent FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
      INSERT INTO probe.p1 SELECT g, '2024-06-01'::date FROM generate_series(1, 1000) g;
      ANALYZE probe.p1;
      CREATE TABLE probe.plain (id bigint PRIMARY KEY, v text);
      ANALYZE probe.plain;
      CREATE VIEW probe.v AS SELECT id, d FROM probe.parent;
      CREATE MATERIALIZED VIEW probe.mv AS SELECT id FROM probe.p1;
    `);

    const catalog = await introspect(client, 'probe');
    validateCatalog(catalog);
    const byName = Object.fromEntries(catalog.tables.map((table) => [table.name, table]));

    assert.deepEqual(Object.keys(byName).sort(), ['mv', 'p1', 'parent', 'plain', 'v']);
    assert.equal(byName.v!.kind, 'view');
    assert.equal(byName.mv!.kind, 'materialized-view');
    // Ordinary and partitioned tables stay unmarked, so kind === undefined keeps
    // meaning "an ordinary table" and existing catalogs remain byte-identical.
    assert.equal(byName.plain!.kind, undefined);
    assert.equal(byName.parent!.kind, undefined);

    // A partitioned parent stores no rows of its own; without summing the partition
    // tree it would report a 1000-row table as empty.
    assert.equal(byName.parent!.rowCount, 1000);
    assert.ok((byName.parent!.sizeBytes ?? 0) > 0);

    // reltuples is -1 for a never-analyzed relation, which validateCatalog rejects as
    // negative. Unknown must arrive as undefined, not as -1 and not as a misleading 0.
    assert.equal(byName.mv!.rowCount, undefined);
    assert.equal(byName.v!.rowCount, undefined);
    assert.equal(byName.v!.sizeBytes, undefined);
    assert.equal(byName.plain!.rowCount, 0); // analyzed and genuinely empty, not unknown

    assert.deepEqual(byName.v!.columns.map((column) => column.name), ['id', 'd']);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
