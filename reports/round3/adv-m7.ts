/**
 * Round-3 M7 critic adversarial harness. Written by the critic, not the builder.
 * Nothing here imports src/report/fixtures.ts.
 */
import { buildModel, renderReport } from '../../src/report/index.ts';
import type { Analysis, Finding, IndexRecommendation, Rewrite } from '../../src/types.ts';

const first = (s: string, n = 16) => s.split('\n').slice(0, n).join('\n');

export function show(name: string, a: unknown, lines = 16) {
  const out = renderReport(a as Analysis, { format: 'markdown' });
  const m = buildModel(a as Analysis);
  console.log('\n' + '='.repeat(76));
  console.log('## ' + name);
  console.log('verdict=' + m.verdict.kind + ' (' + m.verdict.label + ')  issues=' + m.issues.length +
    ' optional=' + m.optional.length + ' cleared=' + m.cleared.length +
    ' depProblems=' + m.dependencyProblems.length + ' validationProblems=' + m.validationProblems.length);
  console.log('-'.repeat(76));
  console.log(first(out, lines));
  console.log('... (' + out.split('\n').length + ' lines)');
  return out;
}

// ---------------------------------------------------------------------------
// A realistic, well-formed base: q05, the NULL-poisoned NOT IN.
// Numbers are from groundtruth/q05-not-in-nullable.txt and my own live checks:
//   NOT IN     -> 0 rows
//   NOT EXISTS -> 196,000 rows
//   14,285 checkout events have customer_id IS NULL
// ---------------------------------------------------------------------------
const Q05_SQL = `SELECT c.customer_id, c.email
FROM shop.customers c
WHERE c.customer_id NOT IN (
    SELECT e.customer_id FROM shop.events e WHERE e.event_type = 'checkout'
);`;

const q05Finding: Finding = {
  id: 'not-in-nullable-subquery',
  title: 'NOT IN over a nullable column returns zero rows',
  severity: 'critical',
  category: 'correctness',
  actionability: 'required',
  evidence: {
    sqlFragment: "c.customer_id NOT IN (SELECT e.customer_id FROM shop.events e WHERE e.event_type = 'checkout')",
    relation: 'shop.events',
    column: 'customer_id',
  },
  impact:
    'shop.events.customer_id is nullable and 14,285 of the checkout events carry NULL, so the NOT IN comparison ' +
    'evaluates to UNKNOWN for every candidate and the query returns 0 rows instead of the 196,000 customers who ' +
    'have never checked out. The result is empty today, and has been silently empty for as long as a NULL existed.',
  remediation: 'Replace NOT IN with NOT EXISTS after confirming the intended population.',
  caveat: 'If events.customer_id were NOT NULL the two forms would agree and this would be a plan issue only.',
  confidence: 'high',
};

const q05Rewrite: Rewrite = {
  id: 'not-exists-antijoin',
  title: 'Use NOT EXISTS so NULLs cannot poison the comparison',
  sql: `SELECT c.customer_id, c.email
FROM shop.customers c
WHERE NOT EXISTS (
    SELECT 1 FROM shop.events e
    WHERE e.event_type = 'checkout' AND e.customer_id = c.customer_id
);`,
  rationale:
    'NOT EXISTS tests row existence rather than membership, so a NULL customer_id in events simply fails the ' +
    'correlation instead of making the whole predicate UNKNOWN. It also lets the planner choose a hashed anti-join.',
  equivalence: 'different-semantics',
  equivalenceNotes:
    'Deliberately different: the current query returns 0 rows and this returns 196,000. Confirm that "customers ' +
    'with no checkout event" is the intended population before shipping.',
  expectedSpeedup: 'Measured 149 ms to about 45 ms, but the reason to change is the answer, not the time.',
  priority: 1,
};

const q05Index: IndexRecommendation = {
  id: 'idx_events_checkout_customer',
  ddl: "CREATE INDEX CONCURRENTLY idx_events_checkout_customer\n    ON shop.events (customer_id)\n    WHERE event_type = 'checkout';",
  table: 'shop.events',
  columns: ['customer_id'],
  method: 'btree',
  where: "event_type = 'checkout'",
  columnOrderRationale: 'Single key column; the event_type equality moves into the index predicate instead.',
  serves: ["the NOT EXISTS correlation on e.customer_id, restricted to event_type = 'checkout'"],
  expectedEffect: 'Lets the anti-join probe 1.0M checkout rows instead of scanning all 5M events.',
  cost: { estimatedSizeNote: '~22 MB over the 1.0M checkout rows', writeImpact: 'One more index on the highest-insert table.' },
  priority: 2,
  confidence: 'medium',
};

export const q05Analysis: Analysis = {
  sql: Q05_SQL,
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres',
    originalSql: Q05_SQL,
    statementType: 'select',
    rootBlockId: 'main',
    bindingErrors: [],
    blocks: [
      {
        id: 'main',
        kind: 'select',
        relations: [{ alias: 'c', source: 'shop.customers', kind: 'table', localPredicates: [], estimatedRows: 200000 }],
        joins: [],
        predicates: [
          {
            sql: 'c.customer_id NOT IN (...)',
            kind: 'subquery',
            columns: [{ table: 'shop.customers', column: 'customer_id' }],
            sargable: false,
            clause: 'where',
            negated: true,
          },
        ],
        projections: [
          { sql: 'c.customer_id', columns: [{ table: 'shop.customers', column: 'customer_id' }] },
          { sql: 'c.email', columns: [{ table: 'shop.customers', column: 'email' }] },
        ],
        groupBy: [],
        having: [],
        orderBy: [],
        windowFunctions: [],
        aggregates: [],
      },
      {
        id: 'sub:1',
        kind: 'subquery',
        relations: [{ alias: 'e', source: 'shop.events', kind: 'table', localPredicates: [], estimatedRows: 1000000 }],
        joins: [],
        predicates: [
          {
            sql: "e.event_type = 'checkout'",
            kind: 'equality',
            columns: [{ table: 'shop.events', column: 'event_type' }],
            sargable: true,
            clause: 'where',
          },
        ],
        projections: [{ sql: 'e.customer_id', columns: [{ table: 'shop.events', column: 'customer_id', nullable: true }] }],
        groupBy: [],
        having: [],
        orderBy: [],
        windowFunctions: [],
        aggregates: [],
      },
    ],
  },
  semantics: {
    headline: 'Customers who have never produced a checkout event — but as written it returns nobody.',
    steps: [
      { title: 'Collect every checkout customer id', detail: 'The subquery reads all checkout events and returns their customer ids, NULLs included.', sqlFragment: "SELECT e.customer_id FROM shop.events e WHERE e.event_type = 'checkout'" },
      { title: 'Keep customers not in that list', detail: 'NOT IN compares each customer id against every value in the list.', sqlFragment: 'c.customer_id NOT IN (...)' },
    ],
    resultShape: {
      grain: 'customer who has never checked out (currently: no rows at all)',
      columns: [
        { name: 'customer_id', meaning: 'The customer.' },
        { name: 'email', meaning: 'Their email address.' },
      ],
    },
    caveats: [
      { issue: 'A single NULL in the subquery empties the result', why: 'NOT IN is UNKNOWN when compared against NULL, and UNKNOWN is not TRUE, so no row survives WHERE.', sqlFragment: 'c.customer_id NOT IN (...)' },
    ],
  },
  execution: {
    accessPaths: [
      { relation: 'shop.customers', path: 'seq-scan', estimatedRows: 200000, reason: 'No usable predicate on customers; every row is tested against the hashed subplan.' },
      { relation: 'shop.events', path: 'seq-scan', estimatedRows: 1000000, reason: 'No index on event_type, so all 5M events are read to build the hashed subplan.' },
    ],
    joinStrategies: [],
    dominantCosts: [
      { what: 'Building the hashed subplan over shop.events', why: 'All 5,000,000 events are scanned to collect 1,000,000 checkout customer ids.', estimatedShare: 0.72 },
    ],
    memoryRisks: [],
    estimationRisks: [],
    scalability: { summary: 'Linear in events; the hashed subplan cannot short-circuit even though the answer is already fixed at zero rows.', complexity: 'O(events + customers)' },
  },
  findings: [q05Finding],
  indexes: [q05Index],
  rewrites: [q05Rewrite],
  verification: { baselineMs: 148.6, optimizedMs: 45.2, resultsMatch: false },
};

// ---------------------------------------------------------------------------
// q07: LEFT JOIN semantically demoted. Intent, not speed. 149,000 rows, ~88 ms.
// ---------------------------------------------------------------------------
const Q07_SQL = `SELECT c.customer_id, c.email, o.order_id, o.total_cents
FROM shop.customers c
LEFT JOIN shop.orders o ON o.customer_id = c.customer_id
WHERE o.status = 'complete'
  AND c.signup_date >= DATE '2024-01-01';`;

export const q07Analysis: Analysis = {
  sql: Q07_SQL,
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres',
    originalSql: Q07_SQL,
    statementType: 'select',
    rootBlockId: 'main',
    bindingErrors: [],
    blocks: [
      {
        id: 'main',
        kind: 'select',
        relations: [
          { alias: 'c', source: 'shop.customers', kind: 'table', localPredicates: [], estimatedRows: 100000 },
          { alias: 'o', source: 'shop.orders', kind: 'table', localPredicates: [], estimatedRows: 1700000 },
        ],
        joins: [
          {
            type: 'left',
            leftRelation: 'shop.customers',
            rightRelation: 'shop.orders',
            equiKeys: [{ left: { table: 'shop.customers', column: 'customer_id' }, right: { table: 'shop.orders', column: 'customer_id' } }],
            residualPredicates: [],
            fanOut: true,
            fanOutReason: 'A customer may have many orders.',
          },
        ],
        predicates: [
          { sql: "o.status = 'complete'", kind: 'equality', columns: [{ table: 'shop.orders', column: 'status' }], sargable: true, clause: 'where' },
          { sql: "c.signup_date >= DATE '2024-01-01'", kind: 'range', columns: [{ table: 'shop.customers', column: 'signup_date' }], sargable: true, clause: 'where' },
        ],
        projections: [
          { sql: 'c.customer_id', columns: [{ table: 'shop.customers', column: 'customer_id' }] },
          { sql: 'o.order_id', columns: [{ table: 'shop.orders', column: 'order_id' }] },
        ],
        groupBy: [],
        having: [],
        orderBy: [],
        windowFunctions: [],
        aggregates: [],
      },
    ],
  },
  semantics: {
    headline: 'Completed orders for customers who signed up in 2024 — written as a LEFT JOIN but behaving as an inner join.',
    steps: [
      { title: 'Outer-join customers to orders', detail: 'Every 2024 customer is paired with their orders, or with NULLs when they have none.' },
      { title: 'Filter on the order status', detail: 'The WHERE clause requires o.status to equal complete, which no NULL-extended row can satisfy.', sqlFragment: "WHERE o.status = 'complete'" },
    ],
    resultShape: {
      grain: 'completed order belonging to a 2024 customer',
      columns: [
        { name: 'customer_id', meaning: 'The customer.' },
        { name: 'order_id', meaning: 'One completed order.' },
      ],
    },
    caveats: [],
  },
  execution: {
    accessPaths: [
      { relation: 'shop.customers', path: 'seq-scan', estimatedRows: 100000, reason: 'signup_date has no index; half the table qualifies.' },
      { relation: 'shop.orders', path: 'index-scan', usingIndex: 'idx_orders_customer_id', estimatedRows: 149000, reason: 'Probed once per qualifying customer.' },
    ],
    joinStrategies: [{ join: 'customers -> orders', algorithm: 'nested-loop', reason: 'The planner demoted the outer join to an inner join and drove from customers.', estimatedRows: 149000 }],
    dominantCosts: [
      { what: 'Nested-loop probes into idx_orders_customer_id', why: '100,000 index descents to produce 149,000 rows.', estimatedShare: 0.6 },
    ],
    memoryRisks: [],
    estimationRisks: [],
    scalability: { summary: 'Linear in qualifying customers.', complexity: 'O(customers)' },
  },
  findings: [
    {
      id: 'outer-join-demoted-by-where',
      title: 'The WHERE clause turns this LEFT JOIN into an inner join',
      severity: 'high',
      category: 'intent',
      actionability: 'required',
      evidence: { sqlFragment: "WHERE o.status = 'complete'", relation: 'shop.orders', column: 'status' },
      impact:
        'A customer with no completed order is NULL-extended by the LEFT JOIN and then removed by o.status = ' +
        "'complete', because NULL = 'complete' is not TRUE. The planner agrees: the captured plan contains an " +
        'ordinary nested loop, not an outer join, and returns 149,000 rows. Whether that is a bug depends on ' +
        'information the analyzer does not have.',
      remediation: 'Decide whether unmatched customers should appear, then move the predicate to ON or write INNER JOIN.',
      confidence: 'high',
    },
  ],
  indexes: [],
  rewrites: [
    {
      id: 'predicate-into-on',
      title: 'Move the status predicate into ON to keep unmatched customers',
      sql: `SELECT c.customer_id, c.email, o.order_id, o.total_cents
FROM shop.customers c
LEFT JOIN shop.orders o
       ON o.customer_id = c.customer_id
      AND o.status = 'complete'
WHERE c.signup_date >= DATE '2024-01-01';`,
      rationale: 'Filtering inside ON is applied before NULL-extension, so customers with no completed order survive with NULL order columns.',
      equivalence: 'different-semantics',
      equivalenceNotes: 'Returns more rows than today: every 2024 customer appears at least once. Choose this only if unmatched customers were meant to be kept.',
      priority: 1,
    },
  ],
  verification: undefined,
};

// ---------------------------------------------------------------------------
// Helpers for mutation probes
// ---------------------------------------------------------------------------
export function clone<T>(x: T): T {
  return structuredClone(x);
}
