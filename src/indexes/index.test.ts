import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CORPUS } from '../../corpus/queries.ts';
import { detectAntiPatterns } from '../antipatterns/index.ts';
import { bindQuery } from '../ir/index.ts';
import { recognizeCreateIndexDdl } from '../report/index-ddl.ts';
import type { Catalog, Finding, IndexRecommendation } from '../types.ts';
import { recommendIndexes } from './index.ts';

const catalog = JSON.parse(
  await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8'),
) as Catalog;

function analyze(sql: string, sourceCatalog: Catalog = catalog): { findings: Finding[]; indexes: IndexRecommendation[] } {
  const ir = bindQuery(sql, sourceCatalog);
  const findings = detectAntiPatterns(ir, sourceCatalog);
  return { findings, indexes: recommendIndexes(ir, sourceCatalog, findings) };
}

function corpusAdvice(shortId: string, sourceCatalog: Catalog = catalog): IndexRecommendation[] {
  const query = CORPUS.find((candidate) => candidate.id.startsWith(shortId));
  assert.ok(query);
  return analyze(query.sql, sourceCatalog).indexes;
}

test('corpus recommendations are deliberately present or empty by structural gate', () => {
  const counts: Record<string, number> = {
    q01: 1, q02: 0, q03: 2, q04: 1, q05: 1, q06: 0,
    q07: 0, q08: 2, q09: 1, q10: 0, q11: 1, q12: 1,
  };
  for (const query of CORPUS) {
    assert.equal(corpusAdvice(query.id.slice(0, 3)).length, counts[query.id.slice(0, 3)], query.id);
  }
});

test('every emitted DDL passes the report runtime recognizer and costs stay unmeasured', () => {
  for (const query of CORPUS) {
    const recommendations = corpusAdvice(query.id.slice(0, 3));
    assert.equal(new Set(recommendations.map((index) => index.id)).size, recommendations.length);
    for (const index of recommendations) {
      assert.equal(recognizeCreateIndexDdl(index.ddl).valid, true, `${query.id}: ${index.ddl}`);
      assert.match(index.ddl, /^CREATE INDEX CONCURRENTLY /);
      assert.match(index.cost.estimatedSizeNote, /unmeasured/i);
      assert.match(index.cost.writeImpact, /maintenance|updates/i);
      assert.doesNotMatch(index.expectedEffect, /\bmeasured\b(?!\/unverified)/i);
      assert.ok(index.columnOrderRationale.trim());
      assert.ok(index.serves.length);
    }
  }
});

test('q01 equality leads range, payload stays INCLUDE, and current SQL is not called fixed', () => {
  const [index] = corpusAdvice('q01');
  assert.deepEqual(index?.columns, ['status', 'created_at']);
  assert.deepEqual(index?.includeColumns, ['total_cents', 'customer_id']);
  assert.match(index!.columnOrderRationale, /equality key and leads/i);
  assert.match(index!.columnOrderRationale, /first range key/i);
  assert.match(index!.expectedEffect, /no useful effect while .* remains wrapped/i);
  assert.match(index!.expectedEffect, /coupled/i);
  assert.ok(index!.columns.every((column) => !index!.includeColumns?.includes(column)));
});

test('deep pagination keeps every sort/cursor column in the key', () => {
  const [index] = corpusAdvice('q04');
  assert.deepEqual(index?.columns, ['status', 'created_at DESC', 'order_id DESC']);
  assert.deepEqual(index?.includeColumns, ['total_cents', 'customer_id']);
  assert.ok(index!.columns.includes('order_id DESC'));
  assert.equal(index!.includeColumns?.includes('order_id'), false);
  assert.match(index!.expectedEffect, /OFFSET still requires visiting 100,000/i);
});

test('correctness and intent gates never receive distracting indexes', () => {
  assert.deepEqual(corpusAdvice('q06'), []);
  assert.deepEqual(corpusAdvice('q07'), []);
  assert.deepEqual(corpusAdvice('q10'), []);

  const q05 = corpusAdvice('q05');
  assert.equal(q05.length, 1);
  assert.match(q05[0]!.expectedEffect, /does not repair.*NOT IN/i);
  assert.match(q05[0]!.where!, /customer_id.*IS NOT NULL/i);
});

test('BRIN requires catalogued physical correlation and falls back to B-tree', () => {
  const [brin] = corpusAdvice('q09');
  assert.equal(brin?.method, 'brin');
  assert.match(brin!.ddl, /USING brin/i);
  assert.match(brin!.ddl, /pages_per_range = 32/i);

  const lowCorrelation = structuredClone(catalog);
  const createdAt = lowCorrelation.tables.find((table) => table.name === 'orders')!
    .columns.find((column) => column.name === 'created_at')!;
  createdAt.stats!.correlation = 0.1;
  const [btree] = corpusAdvice('q09', lowCorrelation);
  assert.equal(btree?.method, 'btree');
  assert.doesNotMatch(btree!.ddl, /USING brin/i);
});

test('JSON advice is an exact partial expression B-tree, not generic GIN', () => {
  const [index] = corpusAdvice('q12');
  assert.equal(index?.method, 'btree');
  assert.match(index!.columns[0]!, /payload.*->>.*utm_source/i);
  assert.equal(index?.columns[1], 'occurred_at');
  assert.deepEqual(index?.includeColumns, ['customer_id']);
  assert.match(index!.where!, /event_type IN/i);
  assert.doesNotMatch(index!.ddl, /USING gin/i);
});

test('rules generalize to a different table/column combination without exact SQL matching', () => {
  const sql = `SELECT count(*)
    FROM shop.events e
    WHERE date_trunc('month', e.occurred_at) = TIMESTAMPTZ '2025-02-01'
      AND e.event_type = 'checkout'`;
  const [index] = analyze(sql).indexes;
  assert.equal(index?.table, 'events');
  assert.deepEqual(index?.columns, ['event_type', 'occurred_at']);
  assert.match(index!.expectedEffect, /coupled/i);
});

test('no M4 evidence means no index, and an equivalent catalog index is not duplicated', () => {
  const query = CORPUS.find((candidate) => candidate.id.startsWith('q01'))!;
  const ir = bindQuery(query.sql, catalog);
  assert.deepEqual(recommendIndexes(ir, catalog, []), []);

  const extended = structuredClone(catalog);
  extended.tables.find((table) => table.name === 'orders')!.indexes.push({
    name: 'already_there',
    table: 'orders',
    columns: ['status', 'created_at'],
    includeColumns: ['total_cents', 'customer_id'],
    unique: false,
    method: 'btree',
  });
  assert.deepEqual(corpusAdvice('q01', extended), []);
});

test('no index is recommended for a plain view, which has no storage to index', async () => {
  const { loadCatalog } = await import('../catalog.ts');
  const { analyze } = await import('../index.ts');
  const { CORPUS } = await import('../../corpus/queries.ts');
  const query = CORPUS.find((entry) => entry.id.startsWith('q01'))!;
  const base = await loadCatalog(fileURLToPath(new URL('../../corpus/catalog.json', import.meta.url)));

  // The same query against the same shape, differing only in relation kind.
  assert.ok(analyze(query.sql, base).analysis.indexes.length > 0, 'baseline table must yield advice');

  const asView = structuredClone(base);
  asView.tables.find((table) => table.name === 'orders')!.kind = 'view';
  assert.equal(analyze(query.sql, asView).analysis.indexes.length, 0);

  // A materialized view is physical and can be indexed, so it must NOT be excluded.
  const asMaterialized = structuredClone(base);
  asMaterialized.tables.find((table) => table.name === 'orders')!.kind = 'materialized-view';
  assert.ok(analyze(query.sql, asMaterialized).analysis.indexes.length > 0);
});
