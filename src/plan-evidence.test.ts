import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { loadCatalog } from './catalog.ts';
import { analyze } from './index.ts';
import {
  PlanInputError,
  applyPlanEvidence,
  loadPlanEvidence,
  normalizePlanEvidence,
} from './plan-evidence.ts';

const ROOT = new URL('../', import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`groundtruth/${name}.json`, ROOT), 'utf8'));
}

test('normalizes q01 ground truth as analyzed evidence with observed scans and joins', () => {
  const evidence = normalizePlanEvidence(fixture('q01-nonsargable-date'));

  assert.equal(evidence.mode, 'analyzed');
  assert.equal(evidence.root.nodeType, 'Sort');
  assert.equal(evidence.sql?.startsWith('SELECT c.country_code'), true);
  assert.deepEqual(
    evidence.summary.nodeTypes,
    ['Sort', 'Aggregate', 'Gather Merge', 'Nested Loop', 'Seq Scan', 'Index Scan'],
  );
  assert.deepEqual(evidence.summary.relations, ['orders', 'customers']);
  assert.deepEqual(evidence.summary.joins.map((join) => join.algorithm), ['nested-loop']);
  assert.deepEqual(evidence.summary.indexNames, ['customers_pkey']);
  assert.equal(evidence.summary.executionMs, 111.615);
  assert.equal(evidence.summary.planningMs, 0.122);
  assert.deepEqual(evidence.summary.tempIo, { readBlocks: 0, writtenBlocks: 0 });

  const orders = evidence.summary.accessPaths.find((path) => path.relation === 'orders');
  assert.equal(orders?.path, 'seq-scan');
  assert.equal(orders?.actualRows, 16_146);
  assert.equal(orders?.actualLoops, 3);
  const customers = evidence.summary.accessPaths.find((path) => path.relation === 'customers');
  assert.equal(customers?.path, 'index-scan');
  assert.equal(customers?.usingIndex, 'customers_pkey');

  const ordersRatio = evidence.summary.rowEstimateRatios.find((ratio) =>
    ratio.nodeType === 'Seq Scan' && ratio.relation === 'orders',
  );
  assert.equal(ordersRatio?.direction, 'under');
  assert.ok((ordersRatio?.factor ?? 0) > 4.5);
});

test('q10 exposes the bitmap access path and its descendant index without inventing a problem', () => {
  const evidence = normalizePlanEvidence(fixture('q10-having-instead-of-where'));

  assert.equal(evidence.mode, 'analyzed');
  assert.equal(evidence.root.nodeType, 'Aggregate');
  assert.equal(evidence.summary.executionMs, 6.644);
  assert.deepEqual(evidence.summary.indexNames, ['idx_orders_customer_id']);
  assert.deepEqual(evidence.summary.spills, []);
  assert.deepEqual(evidence.summary.joins, []);

  const orders = evidence.summary.accessPaths.find((path) => path.relation === 'orders');
  assert.equal(orders?.path, 'bitmap-heap-scan');
  assert.equal(orders?.usingIndex, 'idx_orders_customer_id');
  assert.equal(orders?.actualRows, 9_990);
});

test('accepts raw PostgreSQL arrays and keeps plan-only evidence unmeasured', () => {
  const evidence = normalizePlanEvidence([{
    Plan: {
      'Node Type': 'Hash Join',
      'Join Type': 'Inner',
      'Plan Rows': 120,
      'Total Cost': 400,
      Plans: [
        {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          Alias: 'o',
          'Plan Rows': 1_000,
          'Total Cost': 250,
        },
        {
          'Node Type': 'Index Only Scan',
          'Relation Name': 'customers',
          Alias: 'c',
          'Index Name': 'customers_pkey',
          'Plan Rows': 200,
          'Total Cost': 100,
        },
      ],
    },
    'Planning Time': 0.4,
  }]);

  assert.equal(evidence.mode, 'plan-only');
  assert.equal(evidence.summary.executionMs, undefined);
  assert.equal(evidence.summary.planningMs, 0.4);
  assert.deepEqual(evidence.summary.rowEstimateRatios, []);
  assert.deepEqual(evidence.summary.joins.map((join) => join.algorithm), ['hash-join']);
  assert.deepEqual(
    evidence.summary.accessPaths.map((path) => [path.relation, path.path, path.usingIndex]),
    [
      ['orders', 'seq-scan', undefined],
      ['customers', 'index-only-scan', 'customers_pkey'],
    ],
  );
});

test('accepts a raw Plan object and reports analyzed spill and temporary I/O facts', () => {
  const evidence = normalizePlanEvidence({
    Plan: {
      'Node Type': 'Sort',
      'Plan Rows': 10_000,
      'Actual Rows': 12_000,
      'Actual Loops': 1,
      'Actual Total Time': 42.5,
      'Sort Method': 'external merge',
      'Sort Space Type': 'Disk',
      'Sort Space Used': 8_192,
      'Temp Read Blocks': 1_024,
      'Temp Written Blocks': 1_030,
    },
    'Execution Time': 43,
  });

  assert.equal(evidence.mode, 'analyzed');
  assert.equal(evidence.summary.executionMs, 43);
  assert.deepEqual(evidence.summary.tempIo, { readBlocks: 1_024, writtenBlocks: 1_030 });
  assert.equal(evidence.summary.spills.length, 1);
  assert.match(evidence.summary.spills[0]?.reason ?? '', /disk-backed external merge/);
  assert.equal(evidence.summary.spills[0]?.sortSpaceKb, 8_192);
});

test('applies analyzed q01 evidence immutably as baseline-only observed execution', async () => {
  const bundle = fixture('q01-nonsargable-date') as { sql: string };
  const catalog = await loadCatalog(new URL('corpus/catalog.json', ROOT).pathname);
  const baseline = analyze(bundle.sql, catalog).analysis;
  const evidence = normalizePlanEvidence(fixture('q01-nonsargable-date'));

  const applied = applyPlanEvidence(baseline, evidence);

  assert.notEqual(applied, baseline);
  assert.notEqual(applied.execution, baseline.execution);
  assert.equal(baseline.verification, undefined);
  assert.equal(applied.verification?.baselinePlan, evidence.document);
  assert.equal(applied.verification?.baselineMs, 111.615);
  assert.equal(applied.verification?.optimizedPlan, undefined);
  assert.equal(applied.verification?.optimizedMs, undefined);
  assert.equal(applied.verification?.resultsMatch, undefined);
  assert.equal(applied.execution.accessPaths.some((path) => path.path === 'seq-scan'), true);
  assert.equal(applied.execution.joinStrategies[0]?.algorithm, 'nested-loop');
  assert.match(applied.execution.accessPaths[0]?.reason ?? '', /Observed in the saved EXPLAIN ANALYZE/);
  assert.match(applied.execution.scalability.summary, /one capture does not establish growth/i);
});

test('applying plan-only evidence captures a baseline plan but creates no runtime or verification verdict', async () => {
  const bundle = fixture('q10-having-instead-of-where') as { sql: string };
  const catalog = await loadCatalog(new URL('corpus/catalog.json', ROOT).pathname);
  const baseline = analyze(bundle.sql, catalog).analysis;
  const evidence = normalizePlanEvidence({
    Plan: {
      'Node Type': 'Bitmap Heap Scan',
      'Relation Name': 'orders',
      Alias: 'o',
      'Plan Rows': 9_761,
      'Total Cost': 8_406.38,
      Plans: [{
        'Node Type': 'Bitmap Index Scan',
        'Index Name': 'idx_orders_customer_id',
        'Plan Rows': 9_761,
        'Total Cost': 86.83,
      }],
    },
  });

  const applied = applyPlanEvidence(baseline, evidence);

  assert.equal(applied.verification?.baselinePlan, evidence.document);
  assert.equal(applied.verification?.baselineMs, undefined);
  assert.equal(applied.verification?.optimizedPlan, undefined);
  assert.equal(applied.verification?.resultsMatch, undefined);
  assert.match(applied.execution.accessPaths[0]?.reason ?? '', /plan-only EXPLAIN/);
  assert.match(applied.execution.dominantCosts[0]?.why ?? '', /not milliseconds or a measured runtime/);
});

test('loads a SQLSage ground-truth bundle from disk', () => {
  const evidence = loadPlanEvidence(new URL('groundtruth/q10-having-instead-of-where.json', ROOT).pathname);
  assert.equal(evidence.mode, 'analyzed');
  assert.equal(evidence.summary.executionMs, 6.644);
});

test('rejects malformed or ambiguous plan inputs with concise PlanInputError messages', () => {
  const invalid: Array<{ input: unknown; message: RegExp }> = [
    { input: '{no', message: /not valid JSON/ },
    { input: {}, message: /missing the top-level Plan/ },
    { input: [], message: /exactly one statement/ },
    { input: [{ Plan: { 'Node Type': 'Result' } }, { Plan: { 'Node Type': 'Result' } }], message: /exactly one statement/ },
    { input: { Plan: { 'Node Type': 42 } }, message: /Plan\.Node Type must be a string/ },
    { input: { Plan: { 'Node Type': 'Result', Plans: {} } }, message: /Plan\.Plans must be an array/ },
    { input: { planJson: { Plan: { 'Node Type': 'Result' } }, sql: 42 }, message: /bundle sql must be a string/ },
  ];

  for (const item of invalid) {
    assert.throws(
      () => normalizePlanEvidence(item.input),
      (error) => {
        assert.ok(error instanceof PlanInputError);
        assert.equal(error.code, 'PLAN_INPUT_INVALID');
        assert.match(error.message, item.message);
        return true;
      },
    );
  }
});

test('row misestimates are filtered, ranked by rows misjudged, and flagged when severe', async () => {
  const catalog = await loadCatalog(new URL('../corpus/catalog.json', import.meta.url).pathname);
  const base = analyze('SELECT order_id FROM shop.orders', catalog).analysis;

  const node = (nodeType: string, planRows: number, actualRows: number, loops = 1) => ({
    'Node Type': nodeType, 'Relation Name': 'orders',
    'Plan Rows': planRows, 'Actual Rows': actualRows, 'Actual Loops': loops,
    'Total Cost': 1, 'Actual Total Time': 1,
  });
  const risksFor = (...nodes: ReturnType<typeof node>[]) => {
    const [root, ...children] = nodes;
    const plan: Record<string, unknown> = { ...root! };
    if (children.length) plan.Plans = children;
    return applyPlanEvidence(base, normalizePlanEvidence([{ Plan: plan, 'Execution Time': 1 }]))
      .execution.estimationRisks;
  };

  // Noise floors: a 5x ratio over four rows, and a large node off by only 1.5x.
  assert.deepEqual(risksFor(node('Seq Scan', 1, 5)), []);
  assert.deepEqual(risksFor(node('Seq Scan', 1000, 1500)), []);

  // A small per-loop error repeated two million times is four million rows misjudged.
  // Judging the floor per loop would discard the most damaging shape there is.
  const nested = risksFor(node('Nested Loop', 1, 3, 2_000_000));
  assert.equal(nested.length, 1);
  assert.match(nested[0]!.why, /4,000,000 row\(s\) misjudged/);
  assert.equal(nested[0]!.severe, false); // a 3x per-loop ratio does not define the plan

  // Severe: large ratio and large consequence, so the renderer can lead with it.
  const severe = risksFor(node('Index Scan', 10_000, 200_000));
  assert.equal(severe[0]!.severe, true);
  assert.equal(severe[0]!.direction, 'under');
  assert.match(severe[0]!.why, /20x more than estimated/);
  assert.match(severe[0]!.why, /usually why the planner chose the shape it did/);

  // Ranked by total rows misjudged, not by ratio: Hash Join is off by ~899,000.
  const ranked = risksFor(node('Hash Join', 1_000, 900_000), node('Sort', 500, 2_000), node('Aggregate', 100, 400));
  assert.deepEqual(ranked.map((risk) => risk.where), ['Hash Join on orders', 'Sort on orders', 'Aggregate on orders']);

  // A plan with no actual rows cannot support any of these claims.
  const planOnly = applyPlanEvidence(base, normalizePlanEvidence([{ Plan: {
    'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 10, 'Total Cost': 1,
  } }]));
  assert.deepEqual(planOnly.execution.estimationRisks, []);
});

test('plan prose states where the evidence came from, not just whether it was analyzed', async () => {
  const catalog = await loadCatalog(new URL('../corpus/catalog.json', import.meta.url).pathname);
  const base = analyze('SELECT order_id FROM shop.orders', catalog).analysis;

  const analyzed = [{
    Plan: {
      'Node Type': 'Seq Scan', 'Relation Name': 'orders',
      'Plan Rows': 100, 'Actual Rows': 5000, 'Actual Loops': 1,
      'Total Cost': 10, 'Actual Total Time': 12,
    },
    'Execution Time': 12,
  }];
  const planOnly = [{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'orders', 'Plan Rows': 100, 'Total Cost': 10 } }];

  const proseOf = (input: unknown, source?: 'live' | 'saved') => {
    const evidence = source === undefined
      ? normalizePlanEvidence(input)
      : normalizePlanEvidence(input, source);
    const e = applyPlanEvidence(base, evidence).execution;
    return [
      ...e.accessPaths.map((p) => p.reason),
      ...e.dominantCosts.map((c) => c.why),
      ...e.estimationRisks.map((r) => r.why),
      e.scalability.summary,
    ].join('\n');
  };

  // Saying "saved" about a plan collected seconds ago by --analyze is untrue, and
  // provenance is exactly what a reader weighs when deciding how far to trust it.
  const liveAnalyzed = proseOf(analyzed, 'live');
  assert.match(liveAnalyzed, /live EXPLAIN ANALYZE/);
  assert.doesNotMatch(liveAnalyzed, /saved/);

  assert.match(proseOf(planOnly, 'live'), /live plan-only EXPLAIN/);
  assert.match(proseOf(analyzed, 'saved'), /saved EXPLAIN ANALYZE/);
  assert.match(proseOf(planOnly, 'saved'), /saved plan-only EXPLAIN/);

  // Absent source defaults to saved, so bundles written before this field keep
  // reading true rather than silently claiming to be live.
  const defaulted = proseOf(analyzed);
  assert.match(defaulted, /saved EXPLAIN ANALYZE/);
  assert.doesNotMatch(defaulted, /\blive\b/);

  // A plan file on disk is a saved plan however it was originally captured.
  assert.equal(normalizePlanEvidence(analyzed, 'live').source, 'live');
  assert.equal(normalizePlanEvidence(JSON.stringify(analyzed)).source, 'saved');
});
