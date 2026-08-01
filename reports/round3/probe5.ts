import { q01 } from './q01.ts';
import { renderReport, buildModel } from '../../src/report/index.ts';
import type { Analysis } from '../../src/types.ts';

const ESC = String.fromCharCode(27);

console.log('#### THE 15-LINE TEST — q01, well-formed, rewrite declares requiresIndexes ####');
console.log(renderReport(q01, { format: 'terminal', color: false }).split('\n').slice(0, 20).join('\n'));

console.log('\n\n#### markdown vs ANSI-stripped terminal ####');
const md = renderReport(q01, { format: 'markdown' });
const plain = renderReport(q01, { format: 'terminal', color: false });
const colored = renderReport(q01, { format: 'terminal', color: true });
const stripped = colored.split(new RegExp(ESC + '\\[[0-9;]*m', 'g')).join('');
console.log('  colored-stripped === plain: ' + (stripped === plain));
const key = (s: string) => new Set(s.replace(/[`*_>#\-\s]+/g, ' ').split(' ').filter((w) => w.length > 5));
const kmd = key(md);
const kpl = key(plain);
console.log('  content words only in markdown: ' + JSON.stringify([...kmd].filter((w) => !kpl.has(w)).slice(0, 8)));
console.log('  content words only in terminal: ' + JSON.stringify([...kpl].filter((w) => !kmd.has(w)).slice(0, 8)));

// ---- my own q10-style no-action case (not the builder's fixture) ----
const Q10 = `SELECT o.customer_id, count(*) AS order_count, sum(o.total_cents) AS revenue
FROM shop.orders o
GROUP BY o.customer_id
HAVING count(*) > 5
   AND o.customer_id < 1000;`;

const q10: Analysis = {
  sql: Q10,
  catalogName: 'corpus/catalog.json',
  ir: {
    dialect: 'postgres', originalSql: Q10, statementType: 'select', rootBlockId: 'main', bindingErrors: [],
    blocks: [{
      id: 'main', kind: 'select',
      relations: [{ alias: 'o', source: 'shop.orders', kind: 'table', localPredicates: [], estimatedRows: 9990 }],
      joins: [], predicates: [],
      projections: [{ sql: 'o.customer_id', columns: [{ table: 'shop.orders', column: 'customer_id' }] }],
      groupBy: [{ table: 'shop.orders', column: 'customer_id' }],
      having: [
        { sql: 'count(*) > 5', kind: 'other', columns: [], sargable: false, clause: 'having' },
        { sql: 'o.customer_id < 1000', kind: 'range', columns: [{ table: 'shop.orders', column: 'customer_id' }], sargable: true, clause: 'having' },
      ],
      orderBy: [], windowFunctions: [], aggregates: [{ sql: 'count(*)', func: 'count' }],
    }],
  },
  semantics: {
    headline: 'Order count and revenue for the first 1,000 customer ids, for customers with more than five orders.',
    steps: [], resultShape: { grain: 'customer under id 1,000 with more than five orders', columns: [] }, caveats: [],
  },
  execution: {
    accessPaths: [{ relation: 'shop.orders', path: 'bitmap-heap-scan', usingIndex: 'idx_orders_customer_id', estimatedRows: 9990, reason: 'The grouping-key predicate is pushed below the aggregate.' }],
    joinStrategies: [], dominantCosts: [], memoryRisks: [], estimationRisks: [],
    scalability: { summary: 'Bounded by the id cutoff, not the table size.' },
  },
  findings: [
    {
      id: 'having-predicate-already-pushed-down',
      title: 'The non-aggregate HAVING predicate is already pushed to an index scan',
      severity: 'info', category: 'performance', actionability: 'none',
      evidence: { sqlFragment: 'HAVING count(*) > 5 AND o.customer_id < 1000', relation: 'shop.orders', column: 'customer_id' },
      impact: 'Because customer_id is a grouping key, PostgreSQL 16 pushes o.customer_id < 1000 below the aggregate: the plan is a Bitmap Index Scan on idx_orders_customer_id with Index Cond (customer_id < 1000), reading 9,990 rows of 2,000,000 in about 6.9 ms. The textbook "move it to WHERE" rule buys nothing here.',
      remediation: 'No change is warranted; moving the predicate is readability only.',
      caveat: 'A non-grouping column in HAVING would NOT be pushed down and the folk rule would apply.',
      confidence: 'high',
    },
    {
      id: 'count-star-belongs-in-having',
      title: 'count(*) > 5 cannot be moved out of HAVING',
      severity: 'info', category: 'performance', actionability: 'none',
      evidence: { sqlFragment: 'HAVING count(*) > 5' },
      impact: 'It filters the aggregate itself, so no WHERE form exists.',
      remediation: 'Leave it where it is.', confidence: 'high',
    },
  ],
  indexes: [], rewrites: [],
  verification: { baselineMs: 6.9, resultsMatch: true },
};

console.log('\n\n#### my own q10 no-action case ####');
console.log('verdict=' + buildModel(q10).verdict.label);
const q10out = renderReport(q10);
console.log(q10out.split('\n').slice(0, 16).join('\n'));
console.log('  ...');
console.log('  total lines: ' + q10out.split('\n').length);
console.log('  mentions a speedup? ' + /speedup|faster/i.test(q10out));
console.log('  proposes an index? ' + /CREATE INDEX/i.test(q10out));
console.log('\n--- tail ---');
console.log(q10out.split('\n').slice(-14).join('\n'));
