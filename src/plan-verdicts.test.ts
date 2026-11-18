import assert from 'node:assert/strict';
import test from 'node:test';

import type { NormalizedPlanNode, ObservedAccessPath } from './plan-evidence.ts';
import { applyPlanVerdicts } from './plan-verdicts.ts';
import type { PlanVerdictFacts } from './plan-verdicts.ts';
import type { Finding } from './types.ts';

function node(overrides: Partial<NormalizedPlanNode> = {}): NormalizedPlanNode {
  return { nodeType: 'Seq Scan', depth: 0, children: [], ...overrides };
}

function access(overrides: Partial<ObservedAccessPath> & Pick<ObservedAccessPath, 'relation' | 'path' | 'nodeType'>): ObservedAccessPath {
  return { ...overrides };
}

function facts(
  nodes: NormalizedPlanNode[],
  accessPaths: ObservedAccessPath[],
): PlanVerdictFacts {
  return { nodes, summary: { accessPaths } };
}

function performanceFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'non-sargable-function-on-column',
    title: 'Function on the filtered column blocks a raw-column search',
    severity: 'medium',
    category: 'performance',
    actionability: 'optional',
    evidence: {
      sqlFragment: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'",
      relation: 'shop.orders',
      column: 'created_at',
    },
    impact: 'The predicate wraps the filtered column.',
    remediation: 'Express the filter on the raw column.',
    confidence: 'high',
    ...overrides,
  };
}

test('a sequential scan confirms a non-sargable finding on the same relation', () => {
  const plan = facts(
    [node({ nodeType: 'Seq Scan', relation: 'orders', schema: 'shop', alias: 'o' })],
    [access({ relation: 'orders', schema: 'shop', path: 'seq-scan', nodeType: 'Seq Scan' })],
  );

  const [finding] = applyPlanVerdicts([performanceFinding()], plan);

  assert.equal(finding?.planVerdict?.status, 'confirmed');
  assert.equal(finding?.planVerdict?.note, 'Plan reads shop.orders with a Seq Scan.');
});

test('an index condition on the finding column contradicts a non-sargable finding', () => {
  const plan = facts(
    [node({
      nodeType: 'Index Scan',
      relation: 'orders',
      schema: 'shop',
      alias: 'o',
      indexName: 'idx_orders_created_at',
      indexCondition: "(created_at >= '2024-03-01 00:00:00+00'::timestamp with time zone)",
    })],
    [access({
      relation: 'orders',
      schema: 'shop',
      path: 'index-scan',
      nodeType: 'Index Scan',
      usingIndex: 'idx_orders_created_at',
    })],
  );

  const [finding] = applyPlanVerdicts([performanceFinding()], plan);

  assert.equal(finding?.planVerdict?.status, 'contradicted');
  assert.match(finding?.planVerdict?.note ?? '', /index condition uses created_at/);
});

test('a Sort node confirms ORDER BY random() LIMIT', () => {
  const plan = facts(
    [node({ nodeType: 'Sort', sortMethod: 'top-N heapsort', sortSpaceType: 'Memory' })],
    [],
  );

  const [finding] = applyPlanVerdicts([performanceFinding({
    id: 'order-by-random-limit',
    evidence: { sqlFragment: 'ORDER BY random() LIMIT 10', relation: 'shop.orders' },
  })], plan);

  assert.equal(finding?.planVerdict?.status, 'confirmed');
  assert.match(finding?.planVerdict?.note ?? '', /Sort/);
});

test('a relation absent from the plan leaves a non-sargable finding not observable', () => {
  const plan = facts(
    [node({ nodeType: 'Seq Scan', relation: 'orders', schema: 'shop' })],
    [access({ relation: 'orders', schema: 'shop', path: 'seq-scan', nodeType: 'Seq Scan' })],
  );

  const [finding] = applyPlanVerdicts([performanceFinding({
    evidence: {
      sqlFragment: "date_trunc('month', c.created_at) = TIMESTAMPTZ '2024-03-01'",
      relation: 'shop.customers',
      column: 'created_at',
    },
  })], plan);

  assert.equal(finding?.planVerdict?.status, 'not-observable');
  assert.equal(finding?.planVerdict?.note, 'Plan does not read shop.customers.');
});
