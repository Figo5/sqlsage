import { clone } from './adv-m7.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';
import type { Analysis } from '../../src/types.ts';
const Q01_SQL = `SELECT c.country_code,
       count(*) AS order_count,
       sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC;`;

const q01: Analysis = {
  sql: Q01_SQL,
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres', originalSql: Q01_SQL, statementType: 'select', rootBlockId: 'main', bindingErrors: [],
    blocks: [{
      id: 'main', kind: 'select',
      relations: [
        { alias: 'o', source: 'shop.orders', kind: 'table', localPredicates: [], estimatedRows: 2000000 },
        { alias: 'c', source: 'shop.customers', kind: 'table', localPredicates: [], estimatedRows: 200000 },
      ],
      joins: [{ type: 'inner', leftRelation: 'shop.orders', rightRelation: 'shop.customers',
        equiKeys: [{ left: { table: 'shop.orders', column: 'customer_id' }, right: { table: 'shop.customers', column: 'customer_id' } }],
        residualPredicates: [], fanOut: false }],
      predicates: [
        { sql: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'", kind: 'other',
          columns: [{ table: 'shop.orders', column: 'created_at' }], sargable: false,
          sargableReason: 'date_trunc() wraps the column', clause: 'where' },
        { sql: "o.status = 'complete'", kind: 'equality', columns: [{ table: 'shop.orders', column: 'status' }], sargable: true, clause: 'where' },
      ],
      projections: [{ sql: 'c.country_code', columns: [{ table: 'shop.customers', column: 'country_code' }] }],
      groupBy: [{ table: 'shop.customers', column: 'country_code' }],
      having: [], orderBy: [], windowFunctions: [], aggregates: [{ sql: 'sum(o.total_cents)', func: 'sum' }],
    }],
  },
  semantics: {
    headline: 'Revenue and order count for March 2024, by customer country.',
    steps: [], resultShape: { grain: 'country with at least one completed March 2024 order', columns: [] }, caveats: [],
  },
  execution: {
    accessPaths: [{ relation: 'shop.orders', path: 'seq-scan', estimatedRows: 48437, reason: 'date_trunc() is not sargable.' }],
    joinStrategies: [], dominantCosts: [], memoryRisks: [], estimationRisks: [],
    scalability: { summary: 'Linear in orders regardless of how narrow the month is.' },
  },
  findings: [{
    id: 'nonsargable-function-on-created-at',
    title: 'date_trunc() on created_at makes the date filter unindexable',
    severity: 'high', category: 'performance', actionability: 'required',
    evidence: { sqlFragment: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'", relation: 'shop.orders', column: 'created_at' },
    impact: 'The planner falls back to a parallel sequential scan of shop.orders that reads 20,630 blocks and discards 650,521 of 666,667 rows per worker.',
    remediation: 'Express the month as a half-open range on the raw created_at column.',
    confidence: 'high',
  }],
  indexes: [{
    id: 'idx_orders_status_created_at_incl',
    ddl: 'CREATE INDEX CONCURRENTLY idx_orders_status_created_at_incl\n    ON shop.orders (status, created_at) INCLUDE (customer_id, total_cents);',
    table: 'shop.orders', columns: ['status', 'created_at'], includeColumns: ['customer_id', 'total_cents'], method: 'btree',
    columnOrderRationale: 'Equality on status leads; created_at is the range key it then bounds.',
    serves: ['the half-open created_at range after the rewrite', "o.status = 'complete'"],
    expectedEffect: 'With the rewrite, an index-only scan: 108.8 ms to 27.6 ms. Alone it measured 113.3 ms — 1.04x SLOWER, and the plan stayed a sequential scan.',
    cost: { estimatedSizeNote: '~86 MB on 2,000,000 rows', writeImpact: 'Low single-digit percent slower inserts.' },
    priority: 1, confidence: 'high',
  }],
  rewrites: [{
    id: 'half-open-month-range',
    title: 'Filter the raw created_at column with a half-open range',
    sql: `SELECT c.country_code, count(*) AS order_count, sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE o.created_at >= TIMESTAMPTZ '2024-03-01 00:00:00+00'
  AND o.created_at <  TIMESTAMPTZ '2024-04-01 00:00:00+00'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC;`,
    rationale: 'Leaves a plain range a btree can bound on both sides. Half-open, not BETWEEN.',
    equivalence: 'conditional',
    equivalenceNotes: 'Identical only when the session TimeZone is UTC.',
    expectedSpeedup: '3.94x, but only together with the companion index.',
    requiresIndexes: ['idx_orders_status_created_at_incl'],
    priority: 1,
  }],
  verification: { baselineMs: 108.8, optimizedMs: 27.6, resultsMatch: true },
};


export { q01 };
