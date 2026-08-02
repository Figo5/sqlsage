import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePlanEvidence } from '../plan-evidence.ts';
import { comparePlans, renderComparison } from './index.ts';

function capture(opts: {
  nodeType?: string; index?: string; ms?: number; analyzed?: boolean;
  planRows?: number; actualRows?: number; sql?: string;
}) {
  const plan: Record<string, unknown> = {
    'Node Type': opts.nodeType ?? 'Seq Scan',
    'Relation Name': 'orders',
    'Plan Rows': opts.planRows ?? 100,
    'Total Cost': 10,
  };
  if (opts.index) plan['Index Name'] = opts.index;
  if (opts.analyzed !== false) {
    plan['Actual Rows'] = opts.actualRows ?? 100;
    plan['Actual Loops'] = 1;
    plan['Actual Total Time'] = opts.ms ?? 100;
  }
  const document: Record<string, unknown> = { Plan: plan };
  if (opts.analyzed !== false) document['Execution Time'] = opts.ms ?? 100;
  return normalizePlanEvidence(opts.sql ? { planJson: [document], sql: opts.sql } : [document]);
}

test('a faster after capture is reported, but never as a benchmark', () => {
  const comparison = comparePlans(capture({ ms: 400 }), capture({ ms: 40 }));
  assert.equal(comparison.verdict.kind, 'faster');
  assert.match(comparison.verdict.headline, /10\.00x faster/);
  // One run each is not a benchmark, and saying so beside the number is the
  // difference between evidence and a claim.
  assert.ok(comparison.verdict.caveats.some((c) => /single capture/.test(c)));
});

test('a plan-only capture yields no timing verdict, because nothing ran', () => {
  const comparison = comparePlans(capture({ analyzed: false }), capture({ ms: 40, nodeType: 'Index Scan' }));
  assert.equal(comparison.timing.comparable, false);
  assert.match(comparison.timing.why!, /plan-only/);
  assert.equal(comparison.verdict.kind, 'shape-changed-only');
  assert.doesNotMatch(comparison.verdict.headline, /faster|slower/);
});

test('a difference two single runs cannot separate from noise is not called an improvement', () => {
  const comparison = comparePlans(capture({ ms: 100 }), capture({ ms: 92 }));
  assert.equal(comparison.verdict.kind, 'no-measurable-change');
  assert.match(comparison.verdict.headline, /cannot separate from noise/);
});

test('comparing two different statements is flagged as such', () => {
  const comparison = comparePlans(
    capture({ ms: 400, sql: 'SELECT a FROM t' }),
    capture({ ms: 40, sql: 'SELECT b FROM u' }),
  );
  assert.equal(comparison.sameQuery, 'different');
  assert.ok(comparison.verdict.caveats.some((c) => /different statements/.test(c)));

  const same = comparePlans(capture({ ms: 400, sql: 'SELECT a FROM t;' }), capture({ ms: 40, sql: 'select  a from t' }));
  assert.equal(same.sameQuery, 'same');
  // Captures that do not state their SQL must not be claimed to match.
  assert.equal(comparePlans(capture({ ms: 1 }), capture({ ms: 1 })).sameQuery, 'unknown');
});

test('structural changes are reported per relation and per index', () => {
  const comparison = comparePlans(
    capture({ ms: 400, nodeType: 'Seq Scan' }),
    capture({ ms: 40, nodeType: 'Index Only Scan', index: 'idx_orders_status_created_at' }),
  );
  const orders = comparison.accessPaths.find((entry) => entry.relation === 'orders')!;
  assert.equal(orders.changed, true);
  assert.match(orders.before!, /Seq Scan/);
  assert.match(orders.after!, /Index Only Scan/);
  assert.deepEqual(comparison.indexes.gained, ['idx_orders_status_created_at']);

  const rendered = renderComparison(comparison, 'markdown');
  assert.match(rendered, /# SQLSage plan comparison/);
  assert.match(rendered, /now used: idx_orders_status_created_at/);
  assert.doesNotMatch(rendered, /\bundefined\b|\bNaN\b/);
});
