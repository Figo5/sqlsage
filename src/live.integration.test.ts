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
