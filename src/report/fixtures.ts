/**
 * Hand-written `Analysis` objects for developing and reviewing the renderer.
 *
 * These exist because M7 is built in parallel with the six modules that feed it,
 * and because you cannot judge a report by staring at a formatter — you have to
 * read one. Every number below is taken from the real plans in `groundtruth/`
 * or from `corpus/catalog.json`, so the output can be assessed the way a reader
 * would assess it, rather than against lorem ipsum.
 *
 * They are test data only. The renderer never imports this file and contains no
 * knowledge of any query in the corpus.
 *
 * Coverage:
 *   fanOutAnalysis  — a correctness bug that must beat the performance work to
 *                     the top of the page, with perf findings also present.
 *   nonSargableAnalysis
 *                   — performance only: four findings across three severities,
 *                     two competing indexes, one conditionally-equivalent rewrite.
 *   healthyAnalysis — the honest "change nothing" report, including a case where
 *                     the textbook advice is wrong and the plan proves it.
 *   degradedAnalysis— binding failed, nothing to say: the renderer must not emit
 *                     empty headers or the word "undefined".
 */

import type { Analysis, ResolvedColumnRef } from '../types.ts';

const ref = (table: string, column: string, dataType?: string, alias?: string): ResolvedColumnRef => ({
  table,
  column,
  dataType,
  alias,
});

// ===========================================================================
// 1. Correctness bug leads, performance findings also present.
//    Shape: aggregate over a join that multiplies its own input.
// ===========================================================================

const FANOUT_SQL = `SELECT c.customer_id,
       c.email,
       sum(o.total_cents) AS revenue_cents,
       count(*) AS item_count
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.customer_id
JOIN shop.order_items oi ON oi.order_id = o.order_id
WHERE o.status = 'complete'
GROUP BY c.customer_id, c.email
ORDER BY revenue_cents DESC
LIMIT 100;`;

export const fanOutAnalysis: Analysis = {
  sql: FANOUT_SQL,
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres',
    originalSql: FANOUT_SQL,
    statementType: 'select',
    rootBlockId: 'main',
    bindingErrors: [],
    blocks: [
      {
        id: 'main',
        kind: 'select',
        relations: [
          { alias: 'c', source: 'shop.customers', kind: 'table', localPredicates: [], estimatedRows: 200000 },
          {
            alias: 'o',
            source: 'shop.orders',
            kind: 'table',
            estimatedRows: 1700000,
            localPredicates: [
              {
                sql: "o.status = 'complete'",
                kind: 'equality',
                columns: [ref('shop.orders', 'status', 'text', 'o')],
                sargable: true,
                selectivity: 0.8499333,
                clause: 'where',
              },
            ],
          },
          { alias: 'oi', source: 'shop.order_items', kind: 'table', localPredicates: [], estimatedRows: 6000048 },
        ],
        joins: [
          {
            type: 'inner',
            leftRelation: 'c',
            rightRelation: 'o',
            equiKeys: [{ left: ref('shop.customers', 'customer_id'), right: ref('shop.orders', 'customer_id') }],
            residualPredicates: [],
            fanOut: true,
            fanOutReason: 'orders.customer_id is not unique: ~10 orders per customer (n_distinct -0.101 over 2,000,000 rows).',
          },
          {
            type: 'inner',
            leftRelation: 'o',
            rightRelation: 'oi',
            equiKeys: [{ left: ref('shop.orders', 'order_id'), right: ref('shop.order_items', 'order_id') }],
            residualPredicates: [],
            fanOut: true,
            fanOutReason:
              'order_items.order_id is not unique: 6,000,048 items over 2,000,000 orders, n_distinct -0.371, so ~3.0 rows per order.',
          },
        ],
        predicates: [
          {
            sql: "o.status = 'complete'",
            kind: 'equality',
            columns: [ref('shop.orders', 'status', 'text', 'o')],
            sargable: true,
            selectivity: 0.8499333,
            clause: 'where',
          },
        ],
        projections: [
          { sql: 'c.customer_id', columns: [ref('shop.customers', 'customer_id', 'bigint', 'c')] },
          { sql: 'c.email', columns: [ref('shop.customers', 'email', 'text', 'c')] },
          { sql: 'sum(o.total_cents)', alias: 'revenue_cents', columns: [ref('shop.orders', 'total_cents', 'integer', 'o')] },
          { sql: 'count(*)', alias: 'item_count', columns: [] },
        ],
        groupBy: [ref('shop.customers', 'customer_id', 'bigint', 'c'), ref('shop.customers', 'email', 'text', 'c')],
        having: [],
        orderBy: [{ column: null, sql: 'revenue_cents', direction: 'desc' }],
        limit: 100,
        windowFunctions: [],
        aggregates: [
          { sql: 'sum(o.total_cents)', func: 'sum' },
          { sql: 'count(*)', func: 'count' },
        ],
      },
    ],
  },

  semantics: {
    headline:
      'Top 100 customers by revenue, where "revenue" is summed once per order line rather than once per order.',
    steps: [
      {
        title: 'Take every completed order',
        detail: 'Orders whose status is "complete" — about 1.7 million of the 2 million rows in the table.',
        sqlFragment: "WHERE o.status = 'complete'",
      },
      {
        title: 'Expand each order into its line items',
        detail:
          'Joining to order_items produces one row per item, so an order with four items appears four times from here on.',
        sqlFragment: 'JOIN shop.order_items oi ON oi.order_id = o.order_id',
      },
      {
        title: 'Add up the order totals per customer',
        detail:
          'sum() runs over the expanded rows, so each order total is added once per item on that order rather than once.',
        sqlFragment: 'sum(o.total_cents) AS revenue_cents',
      },
      {
        title: 'Return the 100 largest',
        detail: 'All 170,000 customer groups are computed first, then the top 100 by revenue are kept.',
        sqlFragment: 'ORDER BY revenue_cents DESC LIMIT 100',
      },
    ],
    resultShape: {
      grain: 'customer, for the 100 customers with the largest (over-counted) revenue',
      columns: [
        { name: 'customer_id', meaning: 'The customer.' },
        { name: 'email', meaning: 'Their email address; also part of the grouping key.' },
        { name: 'revenue_cents', meaning: 'Intended as total order value; actually total order value times items per order.' },
        { name: 'item_count', meaning: 'Number of order lines, not number of orders.' },
      ],
    },
    caveats: [
      {
        issue: 'Customers with no completed orders are absent',
        why:
          'Both joins are inner, so a customer with zero completed orders does not appear at all rather than appearing with a revenue of 0. That may be what you want; it is not what a "revenue per customer" report usually means.',
      },
      {
        issue: 'Grouping by email as well as customer_id is redundant but harmless',
        why:
          'customer_id is the primary key, so email is functionally dependent on it. Postgres allows the shorter GROUP BY c.customer_id, which produces the same groups.',
        sqlFragment: 'GROUP BY c.customer_id, c.email',
      },
    ],
  },

  execution: {
    accessPaths: [
      {
        relation: 'shop.order_items',
        path: 'seq-scan',
        estimatedRows: 6000048,
        reason:
          'No predicate on order_items at all, so every row is read. idx_order_items_order_id exists but a full parallel scan is cheaper than 1.7M index probes.',
      },
      {
        relation: 'shop.orders',
        path: 'seq-scan',
        estimatedRows: 1700000,
        reason: "status = 'complete' keeps 85% of the table; no index would be used for it even if one existed.",
      },
      { relation: 'shop.customers', path: 'seq-scan', estimatedRows: 200000, reason: 'No predicate; the whole table is hashed.' },
    ],
    joinStrategies: [
      {
        join: 'order_items x orders',
        algorithm: 'hash-join',
        reason: 'Both sides are scanned in full and orders fits in a 109 MB parallel hash table.',
        estimatedRows: 5100000,
      },
      {
        join: '(order_items x orders) x customers',
        algorithm: 'hash-join',
        reason: 'customers hashes to 14.6 MB, well inside work_mem.',
        estimatedRows: 5100000,
      },
    ],
    dominantCosts: [
      {
        what: 'The hash join between order_items and orders',
        why:
          'It emits 1,700,000 rows per worker where only 566,667 completed orders exist. Those extra rows are pure duplication and they are what the aggregate then has to chew through.',
        estimatedShare: 0.62,
      },
      {
        what: 'Reading 43,884 blocks of shop.order_items from disk',
        why: '343 MB of the 645 MB table was not in shared_buffers; this is 160 ms of the scan per worker.',
        estimatedShare: 0.16,
      },
      {
        what: 'Building the 170,000-group parallel HashAggregate',
        why: '36.9 MB of hash table per worker, and every group re-hashes the duplicated rows above.',
        estimatedShare: 0.14,
      },
    ],
    memoryRisks: [
      {
        operation: 'Parallel HashAggregate on customer_id',
        why:
          'Reports 36.9 MB per worker against work_mem = 32 MB yet did not spill (Batches: 1) — hash aggregation overshoots before it decides to batch. Roughly 15% growth in customer count tips this into disk batches, at which point the runtime step-changes rather than degrading smoothly.',
      },
    ],
    estimationRisks: [
      {
        where: 'the join between order_items and orders',
        why:
          'The planner estimated 2,124,851 rows and got 1,700,000 per worker, which is close enough. The estimate nobody checks is the semantic one: those rows are duplicates, and no row count will tell you that.',
        direction: 'unknown',
      },
    ],
    scalability: {
      summary:
        'Linear in order_items, not in customers. Adding line items makes the query slower and the reported revenue more wrong at the same time.',
      complexity: 'O(items), with the error term proportional to mean items per order',
    },
  },

  findings: [
    {
      id: 'join-fanout-multiplies-aggregate-input',
      title: 'Revenue is over-counted roughly 3x by the join to order_items',
      severity: 'critical',
      category: 'correctness',
      actionability: 'required',
      evidence: {
        sqlFragment: 'JOIN shop.order_items oi ON oi.order_id = o.order_id',
        relation: 'shop.order_items',
        column: 'order_id',
      },
      impact:
        'order_items holds 6,000,048 rows against 2,000,000 orders — 3.0 items per order (pg_stats n_distinct on order_items.order_id is -0.371). Each order row is duplicated once per line item before sum(o.total_cents) runs, so revenue_cents is inflated by about 3x, and by a different factor for every customer depending on basket size. The plan shows it plainly: 1,700,000 rows per worker reach the aggregate where 566,667 completed orders exist. The error is silent, proportional, and invisible to spot checks.',
      remediation: 'Aggregate order_items to one row per order before joining, so each order contributes its total exactly once.',
      caveat:
        'If order_items were unique on order_id this join could not multiply rows and the totals would be correct. The catalog says it is not unique.',
      confidence: 'high',
    },
    {
      id: 'count-star-counts-wrong-grain',
      title: 'item_count and revenue_cents are counted at different grains',
      severity: 'high',
      category: 'correctness',
      actionability: 'required',
      evidence: {
        sqlFragment: 'count(*) AS item_count',
        relation: 'shop.order_items',
      },
      impact:
        'count(*) counts joined rows, which after the fan-out are order_items rows, not orders — the wrong grain for anything named per-customer. If item_count really is meant to be line items then it is accidentally right, sitting next to a revenue figure that is accidentally wrong. Two columns of the same result set are being counted over different populations.',
      remediation: 'Use count(DISTINCT o.order_id) for orders, or count the items in the pre-aggregate for items — and say which you meant.',
      confidence: 'high',
    },
    {
      id: 'unselective-equality-drives-seq-scan',
      title: "status = 'complete' is too common to be worth an index",
      severity: 'medium',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: "WHERE o.status = 'complete'", relation: 'shop.orders', column: 'status' },
      impact:
        "The MCV list gives status = 'complete' a frequency of 0.8499 — 84.99% of 2,000,000 rows. The scan removes 100,000 rows out of 666,667 per worker. A btree on status alone would be read end to end and the planner would ignore it; the column only earns its place as a secondary key or as a partial-index predicate.",
      remediation: 'Do not index status on its own; make it a trailing key or a partial-index predicate on a more selective column.',
      caveat: "If the workload also asks for the rarer statuses ('pending' at 5.1%, 'shipped' at 8.9%), a partial index on those is a different and better trade.",
      confidence: 'high',
    },
    {
      id: 'full-aggregate-before-limit',
      title: 'LIMIT 100 cannot be pushed below the aggregate',
      severity: 'medium',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: 'ORDER BY revenue_cents DESC LIMIT 100', relation: 'shop.customers' },
      impact:
        'Ordering by an aggregate means all 170,000 groups must exist before the top 100 can be known. The sort itself is cheap — top-N heapsort, 36 kB — so there is nothing to win here directly; the only way to make the LIMIT cheap is to make the aggregate smaller, which the fix above does.',
      remediation: 'Nothing to do in isolation; shrinking the aggregate input is the lever.',
      confidence: 'medium',
    },
    {
      id: 'jit-compilation-overhead',
      title: 'JIT compiled 77 functions for this query',
      severity: 'low',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: '-- JIT: Functions: 77, Total 18.702 ms' },
      impact:
        'JIT cost 18.7 ms of a 2,303 ms run, under 1%. Turning jit off would be measurable but not meaningful, and it would affect every query on the instance.',
      remediation: 'Leave it alone.',
      confidence: 'low',
    },
    {
      id: 'existing-order-items-index-correctly-unused',
      title: 'idx_order_items_order_id is being ignored, and that is correct',
      severity: 'info',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: 'JOIN shop.order_items oi ON oi.order_id = o.order_id', relation: 'shop.order_items' },
      impact:
        'The index exists, and a reader looking at "Parallel Seq Scan on order_items" often assumes it is being missed. It is not: the join needs every one of the 6,000,048 rows, so a sequential read of 43,884 blocks beats 1.7 million random index descents. Forcing the index with enable_seqscan = off makes this query slower.',
      remediation: 'No change.',
      confidence: 'high',
    },
  ],

  indexes: [
    {
      id: 'idx_orders_status_customer_id_incl',
      ddl: 'CREATE INDEX CONCURRENTLY idx_orders_status_customer_id_incl\n    ON shop.orders (status, customer_id) INCLUDE (order_id, total_cents);',
      table: 'shop.orders',
      columns: ['status', 'customer_id'],
      includeColumns: ['order_id', 'total_cents'],
      method: 'btree',
      columnOrderRationale:
        "status leads only because it is the sole equality predicate, and it is a weak leading column at 84.99% of rows. This index does not earn its keep through selectivity — it earns it through the INCLUDE payload, which makes the orders scan index-only and skips the 20,630-block heap read.",
      serves: ["o.status = 'complete'", 'the customer_id / total_cents projection feeding the aggregate'],
      expectedEffect:
        'Replaces the heap scan of orders with an index-only scan, worth an estimated 60-80 ms of the 2,240 ms. It does nothing about the fan-out, which is 62% of the runtime and all of the wrongness.',
      cost: {
        estimatedSizeNote: '~95 MB on 2,000,000 rows (text status plus three 8-byte columns).',
        writeImpact:
          'A second index to maintain on an append-heavy table. Expect 8-12% slower inserts and a larger WAL footprint; a status transition also costs an index update.',
      },
      priority: 2,
      confidence: 'medium',
    },
    {
      id: 'idx_order_items_order_id_covering',
      ddl: 'CREATE INDEX idx_order_items_order_id_covering\n    ON shop.order_items (order_id) INCLUDE (quantity, unit_price_cents);',
      table: 'shop.order_items',
      columns: ['order_id'],
      includeColumns: ['quantity', 'unit_price_cents'],
      method: 'btree',
      columnOrderRationale: 'Single key column, so ordering is not in question.',
      serves: ['the per-order pre-aggregate in the rewrite'],
      expectedEffect:
        'Would let the pre-aggregate run index-only. Whether it beats the existing plan is unverified: the pre-aggregate reads every order, and a full scan of 6M rows may still win.',
      cost: {
        estimatedSizeNote: '~185 MB on 6,000,048 rows — the largest index in the schema.',
        writeImpact: 'order_items is the highest-volume table here; another index on it is the most expensive write cost on offer.',
      },
      redundantWith: ['idx_order_items_order_id'],
      priority: 3,
      confidence: 'low',
    },
  ],

  rewrites: [
    {
      id: 'pre-aggregate-order-items',
      title: 'Collapse order_items to one row per order before joining',
      sql: `SELECT c.customer_id,
       c.email,
       sum(o.total_cents)            AS revenue_cents,
       sum(coalesce(i.item_count,0)) AS item_count
FROM shop.customers c
JOIN shop.orders o ON o.customer_id = c.customer_id
LEFT JOIN (
    SELECT oi.order_id, count(*) AS item_count
    FROM shop.order_items oi
    GROUP BY oi.order_id
) i ON i.order_id = o.order_id
WHERE o.status = 'complete'
GROUP BY c.customer_id, c.email
ORDER BY revenue_cents DESC
LIMIT 100;`,
      rationale:
        "Replaces `JOIN shop.order_items oi ON oi.order_id = o.order_id` with a subquery that is already one row per order, so each order total enters sum() exactly once. `count(*) AS item_count` becomes a sum of per-order counts, which is the number the column name promises. The aggregate's input drops from about 5.1M rows to 1.7M as a side effect.",
      equivalence: 'different-semantics',
      equivalenceNotes:
        'Deliberately different, and in two ways. First, revenue_cents stops being multiplied by items per order — that is the fix, and any dashboard built on the old figure will move by roughly 3x. Second, the join to the pre-aggregate is a LEFT JOIN, so a completed order with no line items now contributes its revenue with item_count 0, where the original dropped it entirely. Use an inner join if dropping it was intended.',
      expectedSpeedup:
        'Measured 2,241 ms to 452 ms on the same data, about 5x — a side effect of the correctness fix, not the reason to make it.',
      priority: 1,
    },
  ],

  verification: {
    baselineMs: 2241.468,
    optimizedMs: 452.0,
    resultsMatch: false,
    baselinePlan: { note: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE) captured' },
    optimizedPlan: { note: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE) captured' },
  },
};

// ===========================================================================
// 2. Performance only: several findings across severities, two competing
//    indexes, one rewrite whose equivalence is conditional.
// ===========================================================================

const NONSARGABLE_SQL = `SELECT c.country_code,
       count(*) AS order_count,
       sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC;`;

export const nonSargableAnalysis: Analysis = {
  sql: NONSARGABLE_SQL,
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres',
    originalSql: NONSARGABLE_SQL,
    statementType: 'select',
    rootBlockId: 'main',
    bindingErrors: [],
    blocks: [
      {
        id: 'main',
        kind: 'select',
        relations: [
          {
            alias: 'o',
            source: 'shop.orders',
            kind: 'table',
            estimatedRows: 48437,
            localPredicates: [
              {
                sql: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'",
                kind: 'equality',
                columns: [ref('shop.orders', 'created_at', 'timestamptz', 'o')],
                sargable: false,
                sargableReason: 'date_trunc() wraps the column, so no btree on created_at can be probed.',
                clause: 'where',
              },
              {
                sql: "o.status = 'complete'",
                kind: 'equality',
                columns: [ref('shop.orders', 'status', 'text', 'o')],
                sargable: true,
                selectivity: 0.8499333,
                clause: 'where',
              },
            ],
          },
          { alias: 'c', source: 'shop.customers', kind: 'table', localPredicates: [], estimatedRows: 200000 },
        ],
        joins: [
          {
            type: 'inner',
            leftRelation: 'o',
            rightRelation: 'c',
            equiKeys: [{ left: ref('shop.orders', 'customer_id'), right: ref('shop.customers', 'customer_id') }],
            residualPredicates: [],
            fanOut: false,
            fanOutReason: 'customers.customer_id is the primary key, so the join is inner-unique.',
          },
        ],
        predicates: [
          {
            sql: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'",
            kind: 'equality',
            columns: [ref('shop.orders', 'created_at', 'timestamptz', 'o')],
            sargable: false,
            sargableReason: 'date_trunc() wraps the column.',
            clause: 'where',
          },
          {
            sql: "o.status = 'complete'",
            kind: 'equality',
            columns: [ref('shop.orders', 'status', 'text', 'o')],
            sargable: true,
            selectivity: 0.8499333,
            clause: 'where',
          },
        ],
        projections: [
          { sql: 'c.country_code', columns: [ref('shop.customers', 'country_code', 'text', 'c')] },
          { sql: 'count(*)', alias: 'order_count', columns: [] },
          { sql: 'sum(o.total_cents)', alias: 'revenue_cents', columns: [ref('shop.orders', 'total_cents', 'integer', 'o')] },
        ],
        groupBy: [ref('shop.customers', 'country_code', 'text', 'c')],
        having: [],
        orderBy: [{ column: null, sql: 'revenue_cents', direction: 'desc' }],
        windowFunctions: [],
        aggregates: [
          { sql: 'count(*)', func: 'count' },
          { sql: 'sum(o.total_cents)', func: 'sum' },
        ],
      },
    ],
  },

  semantics: {
    headline: 'Revenue and order count for March 2024, broken down by the customer’s country.',
    steps: [
      {
        title: 'Keep completed orders created in March 2024',
        detail:
          'The month is selected by truncating each order’s timestamp to the start of its month and comparing that to 2024-03-01.',
        sqlFragment: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'",
      },
      { title: 'Attach the customer', detail: 'Each order is matched to exactly one customer row by primary key.' },
      { title: 'Total by country', detail: 'Orders are counted and their totals summed within each country code.' },
      { title: 'Sort by revenue', detail: 'Countries are listed highest revenue first. Five rows come back.' },
    ],
    resultShape: {
      grain: 'country, for countries with at least one completed March 2024 order',
      columns: [
        { name: 'country_code', meaning: 'The customer’s country, not the shipping destination.' },
        { name: 'order_count', meaning: 'Completed orders created in the month.' },
        { name: 'revenue_cents', meaning: 'Sum of order totals in cents.' },
      ],
    },
    caveats: [
      {
        issue: 'A country with no completed orders in March is missing, not zero',
        why: 'The join and the filter are both inner, so an absent row and a zero are indistinguishable in the output.',
      },
    ],
  },

  execution: {
    accessPaths: [
      {
        relation: 'shop.orders',
        path: 'seq-scan',
        estimatedRows: 48437,
        reason: 'date_trunc() on created_at is not sargable and no index on status exists, so every row is read and tested.',
      },
      {
        relation: 'shop.customers',
        path: 'index-scan',
        usingIndex: 'customers_pkey',
        estimatedRows: 1,
        reason: 'Inner-unique probe on the primary key, one row per surviving order.',
      },
    ],
    joinStrategies: [
      {
        join: 'orders x customers',
        algorithm: 'nested-loop',
        reason: 'Only ~48,000 orders survive the filter, so 48,437 unique index probes beat hashing 200,000 customers.',
        estimatedRows: 48437,
      },
    ],
    dominantCosts: [
      {
        what: 'Parallel sequential scan of shop.orders',
        why:
          'Reads 20,630 blocks and evaluates date_trunc() on 666,667 rows per worker to keep 16,146 of them — 97.6% of the work is thrown away.',
        estimatedShare: 0.7,
      },
      {
        what: '193,750 buffer hits probing customers_pkey',
        why:
          '48,437 nested-loop iterations, one index descent each. 90% of all buffer traffic in the query, but only ~27 ms because the index is fully cached. On a cold cache this becomes the dominant cost instead.',
        estimatedShare: 0.22,
      },
    ],
    memoryRisks: [],
    estimationRisks: [
      {
        where: "the date_trunc() predicate on shop.orders",
        why:
          'The planner estimated 3,541 rows and the scan produced 16,146 per worker — 4.6x under. Postgres has no statistics for a function applied to a column, so it falls back to a fixed guess. This is why the whole plan is built around a row count that is wrong by nearly 5x; after the rewrite the estimate comes from the real histogram and the risk goes away.',
        direction: 'under',
      },
    ],
    scalability: {
      summary:
        'Linear in the size of orders regardless of how narrow the month is. Reporting on one day costs the same as reporting on one year.',
      complexity: 'O(rows in orders) per month reported',
    },
  },

  findings: [
    {
      id: 'non-sargable-function-on-indexed-column',
      title: "date_trunc() on created_at makes the date filter unindexable",
      severity: 'high',
      category: 'performance',
      actionability: 'required',
      evidence: {
        sqlFragment: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'",
        relation: 'shop.orders',
        column: 'created_at',
      },
      impact:
        'Wrapping created_at in a function means no btree index on that column can ever be probed for this predicate, present or future. The planner falls back to a parallel sequential scan that reads 20,630 blocks and discards 650,521 of 666,667 rows per worker. That scan dominates the 108.8 ms measured runtime, and it will grow with the table no matter how narrow the reported month is.',
      remediation: "Express the month as a half-open range on the raw column: created_at >= '2024-03-01' AND created_at < '2024-04-01'.",
      confidence: 'high',
    },
    {
      id: 'equality-before-range-in-composite-index',
      title: "status = 'complete' belongs before the created_at range in the composite index",
      severity: 'medium',
      category: 'performance',
      actionability: 'required',
      evidence: { sqlFragment: "o.status = 'complete'", relation: 'shop.orders', column: 'status' },
      impact:
        "pg_stats puts status = 'complete' at an MCV frequency of 0.8499 — 84.99% of 2,000,000 rows — but selectivity alone does not decide btree key order. PostgreSQL can constrain leading equality keys and then bound the first range key, so (status, created_at) narrows to complete rows inside the month. With (created_at, status), the created_at range ends the navigable prefix and status is only checked while scanning those entries. The live plan confirmed equality-then-range is the useful order here.",
      remediation: 'Order the composite key status first, then the created_at range key.',
      confidence: 'high',
    },
    {
      id: 'nested-loop-buffer-traffic',
      title: 'The join to customers accounts for 90% of buffer traffic',
      severity: 'medium',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: 'JOIN shop.customers c ON c.customer_id = o.customer_id', relation: 'shop.customers' },
      impact:
        '48,437 index probes into customers_pkey produce 193,750 of the query’s 214,394 buffer hits. It costs only ~27 ms today because customers is 24 MB and entirely cached. It is worth knowing that this is the part that degrades first on a colder or busier instance, and that fixing the scan above will not touch it.',
      remediation: 'No change today; revisit if the query moves to an instance where customers is not resident.',
      caveat: 'If shared_buffers ever stops holding customers, the nested loop becomes the wrong plan and a hash join would win.',
      confidence: 'medium',
    },
    {
      id: 'timestamptz-month-boundary-is-session-dependent',
      title: 'Which rows count as "March" depends on the session time zone',
      severity: 'low',
      category: 'intent',
      actionability: 'required',
      evidence: { sqlFragment: "date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'", relation: 'shop.orders', column: 'created_at' },
      impact:
        'date_trunc() on a timestamptz truncates in the session TimeZone, and the literal is also resolved in it. The captured plan ran with TimeZone = UTC. The same query run from a client set to America/New_York shifts the month window by 4-5 hours and returns different totals for the same data — a difference of a few hundred orders at each boundary.',
      remediation: 'Pin the boundaries to an explicit zone rather than inheriting the client’s.',
      confidence: 'medium',
    },
    {
      id: 'plan-choice-is-correct-for-the-query-as-written',
      title: 'The sequential scan is the right plan for this query as written',
      severity: 'info',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: "WHERE date_trunc('month', o.created_at) = ...", relation: 'shop.orders' },
      impact:
        'It is tempting to read "Parallel Seq Scan on shop.orders" as a planner mistake or a missing index. It is neither. With date_trunc() in the predicate there is nothing indexable to choose, and status alone matches 85% of rows. The plan is optimal for the query; the query is the problem.',
      remediation: 'No change to the plan. Change the predicate.',
      confidence: 'high',
    },
  ],

  indexes: [
    {
      id: 'idx_orders_status_created_at_incl',
      ddl: "CREATE INDEX CONCURRENTLY idx_orders_status_created_at_incl\n    ON shop.orders (status, created_at) INCLUDE (customer_id, total_cents);",
      table: 'shop.orders',
      columns: ['status', 'created_at'],
      includeColumns: ['customer_id', 'total_cents'],
      method: 'btree',
      columnOrderRationale:
        "status leads because it is an equality condition and created_at is a range. PostgreSQL can use equality constraints on leading btree columns plus the inequality constraints on the first non-equality column to bound the scan. The 84.99% status frequency makes this only modestly narrower than the month range alone, but it does not reverse the equality-before-range rule.",
      serves: [
        "o.created_at >= '2024-03-01' AND o.created_at < '2024-04-01' (after the rewrite)",
        "o.status = 'complete'",
        'the customer_id and total_cents projection, index-only',
      ],
      expectedEffect:
        'Together with the range rewrite, turns the 20,630-block parallel sequential scan into an index-only scan: 108.8 ms to 27.6 ms, 3.94x faster with identical results. This index does nothing alone — with date_trunc() still present, the measured plan remains a sequential scan at 113.3 ms.',
      cost: {
        estimatedSizeNote: '~86 MB on 2,000,000 rows.',
        writeImpact:
          'orders is append-heavy and created_at correlates with insertion order (pg_stats correlation 1.0), so the new entries land at the right edge of the btree and page splits stay cheap. Expect low single-digit percent slower inserts.',
      },
      priority: 1,
      confidence: 'high',
    },
    {
      id: 'idx_orders_created_at_complete',
      ddl: "CREATE INDEX idx_orders_created_at_complete\n    ON shop.orders (created_at) INCLUDE (customer_id, total_cents)\n    WHERE status = 'complete';",
      table: 'shop.orders',
      columns: ['created_at'],
      includeColumns: ['customer_id', 'total_cents'],
      where: "status = 'complete'",
      method: 'btree',
      columnOrderRationale:
        'One key column, so order is not in question. Moving status into the index predicate instead of the key drops a column from every entry and excludes the 15% of rows that are not complete.',
      serves: ["o.created_at range, restricted to status = 'complete'"],
      expectedEffect:
        'Produces the same index-only scan as the recommendation above for this query, in about 15% less space. It stops helping the moment someone asks the same question about a different status.',
      cost: {
        estimatedSizeNote: '~62 MB — 85% of the rows and one fewer key column.',
        writeImpact:
          'Cheaper to maintain than the composite, with one trap: a row whose status transitions into or out of "complete" costs an index insert plus a delete rather than an in-place update.',
      },
      redundantWith: ['idx_orders_status_created_at_incl'],
      priority: 2,
      confidence: 'medium',
    },
  ],

  rewrites: [
    {
      id: 'half-open-range-on-raw-column',
      title: 'Filter the raw created_at column with a half-open range',
      sql: `SELECT c.country_code,
       count(*)           AS order_count,
       sum(o.total_cents) AS revenue_cents
FROM shop.orders o
JOIN shop.customers c ON c.customer_id = o.customer_id
WHERE o.created_at >= TIMESTAMPTZ '2024-03-01 00:00:00+00'
  AND o.created_at <  TIMESTAMPTZ '2024-04-01 00:00:00+00'
  AND o.status = 'complete'
GROUP BY c.country_code
ORDER BY revenue_cents DESC;`,
      rationale:
        "Removes the function from `date_trunc('month', o.created_at) = TIMESTAMPTZ '2024-03-01'`, leaving a plain range on shop.orders.created_at that a btree can bound on both sides. Half-open (>= and <) rather than BETWEEN: BETWEEN’s inclusive upper bound would also match a row stamped exactly 2024-04-01 00:00:00.",
      equivalence: 'conditional',
      equivalenceNotes:
        "Identical only when the session TimeZone is UTC. date_trunc('month', <timestamptz>) truncates in the session zone, while the literals above are pinned to +00; under TimeZone = 'America/New_York' the original selects a window shifted by five hours and the two forms disagree at both month boundaries. Either pin the zone in the session, or write date_trunc('month', o.created_at AT TIME ZONE 'UTC') if the local-month reading was what you meant.",
      expectedSpeedup:
        '108.8 ms to 27.6 ms once the covering index below exists — 3.94x. The index alone measured 113.3 ms with the same sequential scan, so these changes must be deployed and judged as a pair.',
      requiresIndexes: ['idx_orders_status_created_at_incl'],
      priority: 1,
    },
  ],

  verification: {
    baselineMs: 108.8,
    optimizedMs: 27.6,
    resultsMatch: true,
    baselinePlan: { note: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE) captured' },
    optimizedPlan: { note: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE) captured' },
  },
};

// ===========================================================================
// 3. "This is fine, change nothing" — including a piece of textbook advice
//    that does not apply here, with the plan as evidence.
// ===========================================================================

const HEALTHY_SQL = `SELECT o.customer_id, count(*) AS order_count, sum(o.total_cents) AS revenue
FROM shop.orders o
GROUP BY o.customer_id
HAVING count(*) > 5
   AND o.customer_id < 1000;`;

export const healthyAnalysis: Analysis = {
  sql: HEALTHY_SQL,
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres',
    originalSql: HEALTHY_SQL,
    statementType: 'select',
    rootBlockId: 'main',
    bindingErrors: [],
    blocks: [
      {
        id: 'main',
        kind: 'select',
        relations: [{ alias: 'o', source: 'shop.orders', kind: 'table', localPredicates: [], estimatedRows: 9990 }],
        joins: [],
        predicates: [],
        projections: [
          { sql: 'o.customer_id', columns: [ref('shop.orders', 'customer_id', 'bigint', 'o')] },
          { sql: 'count(*)', alias: 'order_count', columns: [] },
          { sql: 'sum(o.total_cents)', alias: 'revenue', columns: [ref('shop.orders', 'total_cents', 'integer', 'o')] },
        ],
        groupBy: [ref('shop.orders', 'customer_id', 'bigint', 'o')],
        having: [
          {
            sql: 'count(*) > 5',
            kind: 'other',
            columns: [],
            sargable: false,
            sargableReason: 'Filter on an aggregate; it can only be evaluated after grouping.',
            clause: 'having',
          },
          {
            sql: 'o.customer_id < 1000',
            kind: 'range',
            columns: [ref('shop.orders', 'customer_id', 'bigint', 'o')],
            sargable: true,
            selectivity: 0.005,
            clause: 'having',
          },
        ],
        orderBy: [],
        windowFunctions: [],
        aggregates: [
          { sql: 'count(*)', func: 'count' },
          { sql: 'sum(o.total_cents)', func: 'sum' },
        ],
      },
    ],
  },

  semantics: {
    headline: 'Order count and revenue for the first 1,000 customer ids, limited to customers with more than five orders.',
    steps: [
      { title: 'Group orders by customer', detail: 'Every order is bucketed by the customer who placed it.' },
      {
        title: 'Keep only low customer ids and busy customers',
        detail:
          'Two conditions are applied after grouping: the customer id must be under 1,000, and the group must contain more than five orders.',
        sqlFragment: 'HAVING count(*) > 5 AND o.customer_id < 1000',
      },
    ],
    resultShape: {
      grain: 'customer, for customers with id under 1,000 and more than five orders',
      columns: [
        { name: 'customer_id', meaning: 'The customer.' },
        { name: 'order_count', meaning: 'Orders of any status — this query does not filter on status.' },
        { name: 'revenue', meaning: 'Sum of order totals in cents, again across all statuses.' },
      ],
    },
    caveats: [
      {
        issue: 'Cancelled and pending orders are included',
        why:
          'There is no status filter, so revenue here counts every order regardless of whether it completed. About 15% of orders are not complete. That may be intentional; it is worth being sure.',
      },
    ],
  },

  execution: {
    accessPaths: [
      {
        relation: 'shop.orders',
        path: 'bitmap-heap-scan',
        usingIndex: 'idx_orders_customer_id',
        estimatedRows: 9990,
        reason: 'customer_id < 1000 is pushed below the aggregate and served as an Index Cond, reading 9,990 of 2,000,000 rows.',
      },
    ],
    joinStrategies: [],
    dominantCosts: [
      {
        what: 'The bitmap heap fetch of 9,987 blocks',
        why: 'The index supplies 9,990 row pointers in 0.5 ms; reading their heap pages is 4.2 ms of the 6.4 ms total.',
        estimatedShare: 0.65,
      },
    ],
    memoryRisks: [],
    estimationRisks: [],
    scalability: {
      summary:
        'Cost tracks the number of orders below the id cutoff, not the size of the table — the index bounds the work. Raising the cutoff to include all customers turns this into a 2M-row aggregate and a very different query.',
      complexity: 'O(matching rows)',
    },
  },

  findings: [
    {
      id: 'non-aggregate-filter-in-having-is-already-pushed-down',
      title: 'The non-aggregate filter in HAVING is already pushed down — moving it to WHERE buys nothing',
      severity: 'info',
      category: 'performance',
      actionability: 'optional',
      evidence: { sqlFragment: 'o.customer_id < 1000', relation: 'shop.orders', column: 'customer_id' },
      impact:
        'The standard advice is that a non-aggregate condition in HAVING forces the engine to aggregate the whole table first, so it must be moved to WHERE. That is not what happens here. Because customer_id is a grouping key, PostgreSQL 16 is free to push the predicate below the aggregate, and it does: the plan shows Bitmap Index Scan on idx_orders_customer_id with Index Cond (customer_id < 1000), reading 9,990 rows out of 2,000,000 — 0.5% of the table — for 10,001 buffer hits and 6.4 ms end to end. There is no full scan to avoid, so there is no speedup to win.',
      remediation: 'Nothing for performance. Move it to WHERE only if you find it clearer to read.',
      caveat:
        'The pushdown is legal precisely because customer_id appears in GROUP BY. The same predicate on a non-grouping column could not be pushed down, and there the usual advice would be right — that distinction is what the blanket rule flattens.',
      confidence: 'high',
    },
    {
      id: 'aggregate-filter-correctly-in-having',
      title: 'count(*) > 5 belongs in HAVING and cannot be moved',
      severity: 'info',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: 'HAVING count(*) > 5', relation: 'shop.orders' },
      impact:
        'It is a filter on the aggregate itself, so there is no WHERE form of it. The two conditions in this HAVING are genuinely different in kind, which is the reason a blanket "move filters out of HAVING" rule misfires on this query.',
      remediation: 'No change.',
      confidence: 'high',
    },
    {
      id: 'covering-index-could-avoid-heap-fetch',
      title: 'A covering index might avoid the 9,987-block heap fetch',
      severity: 'low',
      category: 'performance',
      actionability: 'none',
      evidence: { sqlFragment: 'sum(o.total_cents)', relation: 'shop.orders', column: 'total_cents' },
      impact:
        'The bitmap heap scan touches 9,987 blocks to read two columns. An index on customer_id INCLUDE (total_cents) could in principle make it index-only and save perhaps 3-4 ms of the 6.4 ms — but that estimate is unverified, visibility-map coverage would decide it, and it means another index on a 2,000,000-row table for a query that already runs in single-digit milliseconds.',
      remediation: 'Not worth it at this size.',
      confidence: 'low',
    },
  ],

  indexes: [],

  rewrites: [
    {
      id: 'move-grouping-key-filter-to-where',
      title: 'Move the row filter from HAVING to WHERE, for readability',
      sql: `SELECT o.customer_id, count(*) AS order_count, sum(o.total_cents) AS revenue
FROM shop.orders o
WHERE o.customer_id < 1000
GROUP BY o.customer_id
HAVING count(*) > 5;`,
      rationale:
        'Puts `o.customer_id < 1000` where a reader of shop.orders expects a row filter, and leaves count(*) > 5 in HAVING where it has to be. This is a change for the next person to read the query, not for the planner.',
      equivalence: 'exact',
      equivalenceNotes:
        'Same rows, and — checked against EXPLAIN rather than assumed — the same plan: an identical Bitmap Index Scan on idx_orders_customer_id with the same Index Cond.',
      expectedSpeedup: 'None. 6.4 ms before, 6.3 ms after, which is inside run-to-run noise.',
      priority: 3,
    },
  ],

  verification: {
    baselineMs: 6.4,
    optimizedMs: 6.3,
    resultsMatch: true,
    baselinePlan: { note: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE) captured' },
    optimizedPlan: { note: 'EXPLAIN (ANALYZE, BUFFERS, VERBOSE) captured' },
  },
};

// ===========================================================================
// 4. Degraded input: binding failed, no execution analysis, nothing found.
//    The renderer must say so rather than printing empty headings.
// ===========================================================================

export const degradedAnalysis = {
  sql: 'SELECT * FROM reporting.v_orders_wide WHERE region_code = $1;',
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres',
    originalSql: 'SELECT * FROM reporting.v_orders_wide WHERE region_code = $1;',
    statementType: 'select',
    rootBlockId: 'main',
    blocks: [],
    bindingErrors: [
      {
        message: 'Relation "reporting.v_orders_wide" is not in the catalog, so no column in this query could be resolved',
        sqlFragment: 'FROM reporting.v_orders_wide',
        severity: 'error',
      },
      {
        message: 'Parameter $1 has no declared type; selectivity for region_code could not be estimated',
        sqlFragment: 'region_code = $1',
        severity: 'warn',
      },
    ],
  },
  semantics: {
    headline: '',
    steps: [],
    resultShape: { grain: '', columns: [] },
    caveats: [],
  },
  findings: [],
  indexes: [],
  rewrites: [],
} as unknown as Analysis;

export const FIXTURES: Array<{ name: string; note: string; analysis: Analysis }> = [
  {
    name: 'fan-out double count',
    note: 'Correctness bug leads; performance findings, two indexes and a rewrite also present.',
    analysis: fanOutAnalysis,
  },
  {
    name: 'non-sargable date filter',
    note: 'Performance only: four findings across three severities, two competing indexes, one conditional rewrite.',
    analysis: nonSargableAnalysis,
  },
  {
    name: 'healthy query (folk rule does not apply)',
    note: 'Nothing to change, and the textbook advice for this shape is wrong here.',
    analysis: healthyAnalysis,
  },
  {
    name: 'degraded input',
    note: 'Binding failed, no execution analysis, no findings.',
    analysis: degradedAnalysis,
  },
];
