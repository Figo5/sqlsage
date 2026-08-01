import { q05Analysis, clone } from './adv-m7.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';
import type { Analysis } from '../../src/types.ts';

const sec = (t: string) => console.log('\n' + '='.repeat(76) + '\n## ' + t + '\n' + '='.repeat(76));

// ===========================================================================
// D6b: the q01 anchor. Measured truth (HANDOFF.md, groundtruth):
//   index alone            -> 1.04x SLOWER, index unused, still a seq scan
//   half-open rewrite+index-> 3.94x faster, index-only scan, identical digest
// The rewrite declares requiresIndexes. Can a reader apply the index alone?
// ===========================================================================
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

sec('D6b. q01 as authored — coupling holds?');
const m = buildModel(q01);
m.issues.forEach((i, n) => console.log(`  §${n + 1} ${i.kind} "${i.title}" rw=[${i.rewrites.map(r => r.id)}] idx=[${i.indexes.map(x => x.id)}]`));
console.log(renderReport(q01).split('\n').filter((l) => /^1\. |^2\. /.test(l)).join('\n'));

sec('D6c. q01 with the SAME facts, only the rewrite prose reworded (no schema tokens)');
const q01b = clone(q01) as Analysis;
q01b.rewrites[0].id = 'half-open-range';
q01b.rewrites[0].title = 'Use a half-open range instead of truncating the timestamp';
q01b.rewrites[0].rationale = 'Leaves a plain range that a btree can bound on both sides. Half-open, not BETWEEN.';
q01b.rewrites[0].equivalenceNotes = 'Identical only when the session TimeZone is UTC.';
const m2 = buildModel(q01b);
m2.issues.forEach((i, n) => console.log(`  §${n + 1} ${i.kind} "${i.title}" rw=[${i.rewrites.map(r => r.id)}] idx=[${i.indexes.map(x => x.id)}]`));
console.log('depProblems=' + m2.dependencyProblems.length);
console.log(renderReport(q01b).split('\n').filter((l) => /^1\. |^2\. |^## /.test(l)).join('\n'));

// ===========================================================================
// Backtick fences
// ===========================================================================
sec('E1. triple / quadruple / sextuple backtick runs in SQL and DDL');
for (const run of [3, 4, 6]) {
  const a = clone(q05Analysis) as Analysis;
  const ticks = '`'.repeat(run);
  a.sql = `SELECT 1; -- ${ticks}\n# injected heading\n<script>alert(1)</script>`;
  a.ir.originalSql = a.sql;
  a.indexes[0].ddl = `CREATE INDEX x ON t (a); -- ${ticks}sql\n# injected DDL heading`;
  const out = renderReport(a, { format: 'markdown' });
  const fenceLines = out.split('\n').filter((l) => /^`{3,}/.test(l));
  console.log(`  run=${run}: fences used -> ${[...new Set(fenceLines.map((l) => l.match(/^`+/)![0].length))].join(',')}`);
  console.log('    injected heading became a real markdown heading? ' +
    out.split('\n').some((l) => l === '# injected heading' || l === '# injected DDL heading'));
}

// ===========================================================================
// Extreme finite timings
// ===========================================================================
sec('E2. extreme positive finite timing endpoints');
const timings: Array<[string, number, number]> = [
  ['1 / Number.MIN_VALUE', 1, Number.MIN_VALUE],
  ['Number.MAX_VALUE / 1', Number.MAX_VALUE, 1],
  ['1e308 baseline, 1e-308 optimized', 1e308, 1e-308],
  ['tiny both (below display resolution)', 1e-7, 2e-7],
  ['baseline 100, optimized 1e-10', 100, 1e-10],
  ['identical 12.5 / 12.5', 12.5, 12.5],
];
for (const [name, b, o] of timings) {
  const a = clone(q05Analysis) as Analysis;
  a.verification = { baselineMs: b, optimizedMs: o, resultsMatch: true };
  const out = renderReport(a);
  const line = out.split('\n').find((l) => /timing|Live timing/i.test(l)) ?? '(no timing line)';
  console.log(`  ${name}\n    -> ${line}`);
  if (/Infinity|NaN|\b0\.0 ms\b/.test(out)) console.log('    !!! contains Infinity/NaN/fake 0.0 ms');
}

// ===========================================================================
// resultsMatch === false loudness
// ===========================================================================
sec('E3. resultsMatch=false with an EXACT rewrite and no correctness finding');
const e3 = clone(q05Analysis) as Analysis;
e3.findings = [];
e3.rewrites[0].equivalence = 'exact';
e3.rewrites[0].equivalenceNotes = 'Provably identical.';
e3.verification = { baselineMs: 148.6, optimizedMs: 45.2, resultsMatch: false };
console.log(renderReport(e3).split('\n').slice(0, 18).join('\n'));

// ===========================================================================
// NO_COLOR / non-TTY / determinism
// ===========================================================================
sec('E4. determinism, NO_COLOR, non-TTY');
const r1 = renderReport(q01, { format: 'terminal' });
const r2 = renderReport(q01, { format: 'terminal' });
console.log('  same-process determinism: ' + (r1 === r2));
console.log('  auto-detect emitted ANSI (non-TTY expected false): ' + /\[/.test(r1));
const before = JSON.stringify(q01);
renderReport(q01);
console.log('  input not mutated: ' + (JSON.stringify(q01) === before));
