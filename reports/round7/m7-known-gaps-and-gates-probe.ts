/** Round-7 independent M7 probe: preserved gates and unwaived non-DDL gaps. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Analysis, Finding, IndexRecommendation, Rewrite } from '../../src/types.ts';
import { analyze } from '../../src/index.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';
import { healthyAnalysis } from '../../src/report/fixtures.ts';

const SQL = 'SELECT t.id FROM generic.things t WHERE t.flag = true;';
const clone = <T>(value: T): T => structuredClone(value);

function base(): Analysis {
  const a = clone(healthyAnalysis);
  a.sql = SQL;
  a.ir.originalSql = SQL;
  a.ir.bindingErrors = [];
  a.ir.blocks[0].relations = [{ alias: 't', source: 'generic.things', kind: 'table', localPredicates: [] }];
  a.ir.blocks[0].predicates = [];
  a.ir.blocks[0].having = [];
  a.ir.blocks[0].projections = [{ sql: 't.id', columns: [{ alias: 't', table: 'generic.things', column: 'id' }] }];
  a.ir.blocks[0].groupBy = [];
  a.ir.blocks[0].orderBy = [];
  a.ir.blocks[0].aggregates = [];
  a.semantics = {
    headline: 'Generic critic-authored report probe.',
    steps: [{ title: 'Read matching rows', detail: 'Returns rows satisfying the flag.' }],
    resultShape: { grain: 'matching thing', columns: [{ name: 'id', meaning: 'Identifier.' }] },
    caveats: [],
  };
  a.execution = {
    accessPaths: [{ relation: 'generic.things', path: 'seq-scan', reason: 'No supplied index.' }],
    joinStrategies: [], dominantCosts: [{ what: 'Scan generic.things', why: 'Every row is inspected.', estimatedShare: 0.8 }],
    memoryRisks: [], estimationRisks: [], scalability: { summary: 'Linear in table size.' },
  };
  a.findings = [];
  a.indexes = [];
  a.rewrites = [];
  a.verification = undefined;
  a.missingModules = undefined;
  return a;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'generic-risk', title: 'A proven result defect', severity: 'critical',
    category: 'correctness', actionability: 'required',
    evidence: { sqlFragment: 't.flag = true', relation: 'generic.things', column: 'flag' },
    impact: 'The query returns a provably incorrect population.',
    remediation: 'Replace the predicate with the validated form.', confidence: 'high',
    ...overrides,
  };
}

function index(ddl = 'CREATE INDEX ix_required ON generic.things (flag);'): IndexRecommendation {
  return {
    id: 'ix_required', ddl, table: 'generic.things', columns: ['flag'], method: 'btree',
    columnOrderRationale: 'One key column.', serves: ['t.flag = true'], expectedEffect: 'Predicted index scan.',
    cost: { estimatedSizeNote: 'Unknown.', writeImpact: 'Adds write maintenance.' }, priority: 1, confidence: 'high',
  };
}

function rewrite(): Rewrite {
  return {
    id: 'repair-query', title: 'Apply the validated repair',
    sql: 'SELECT t.id FROM generic.things t WHERE t.flag IS TRUE;', rationale: 'Uses the validated form.',
    equivalence: 'different-semantics', equivalenceNotes: 'The result differs because the current population is wrong.',
    requiresIndexes: ['ix_required'], priority: 1,
  };
}

// missingModules: normal values work; malformed runtime declarations assert a
// false clean bill of health.
for (const value of [undefined, [], ['', '   ']] as Array<string[] | undefined>) {
  const a = base(); a.missingModules = value;
  assert.notEqual(buildModel(a).verdict.kind, 'incomplete');
}
{
  const a = base(); a.missingModules = [' M4 ', 'M2', 'M4', ''];
  assert.equal(buildModel(a).verdict.kind, 'incomplete');
  assert.match(renderReport(a), /analyzer modules M2, M4/);
}
for (const value of ['M4', [42]]) {
  const a = base() as Analysis & { missingModules: unknown }; a.missingModules = value;
  assert.equal(buildModel(a as Analysis).verdict.kind, 'clean');
}
console.log('PASS valid missingModules behavior; DEFECT malformed runtime values assert completeness');

// Binding and six blank safety fields.
{
  const hard = base(); hard.findings = [finding()]; hard.ir.bindingErrors = [{ message: 'Unknown column.', severity: 'error' }];
  assert.equal(buildModel(hard).verdict.kind, 'incomplete');
  const warn = base(); warn.findings = [finding()]; warn.ir.bindingErrors = [{ message: 'Uncertain.', severity: 'warn' }];
  assert.equal(buildModel(warn).verdict.kind, 'wrong-results');
}
const blankCases: Array<() => Analysis> = [
  () => { const a = base(); a.findings = [finding({ evidence: { sqlFragment: '  ' } })]; return a; },
  () => { const a = base(); a.findings = [finding({ impact: '  ' })]; return a; },
  () => { const a = base(); a.findings = [finding({ remediation: '  ' })]; return a; },
  () => { const a = base(); const r = rewrite(); r.sql = '  '; a.rewrites = [r]; return a; },
  () => { const a = base(); a.indexes = [index('  ')]; a.rewrites = [rewrite()]; return a; },
  () => { const a = base(); a.sql = '  '; return a; },
];
for (const make of blankCases) assert.equal(buildModel(make()).verdict.kind, 'incomplete');
console.log('PASS hard binding, warning-only control, and all six blank safety gates');

// Recovered optional presentation noise still suppresses proven correctness.
for (const mutate of [
  (a: Analysis) => { a.execution.accessPaths[0].path = 'typo' as never; },
  (a: Analysis) => { a.execution.dominantCosts[0].estimatedShare = 1.5; },
]) {
  const a = base(); a.findings = [finding()]; mutate(a);
  assert.equal(buildModel(a).verdict.kind, 'incomplete');
}
console.log('DEFECT recovered optional validation noise still suppresses categorical correctness');

// Structural category/actionability remains sound; correctness+none still
// hides the supplied manual remediation.
{
  const a = base(); a.findings = [finding({ category: 'performance', actionability: 'none', title: 'WRONG RESULTS fix now' })];
  assert.equal(buildModel(a).verdict.kind, 'clean');
  assert.doesNotMatch(renderReport(a), /## Do this first/);
}
{
  const a = base(); a.findings = [finding({ actionability: 'none' })];
  assert.equal(buildModel(a).verdict.kind, 'wrong-results');
  assert.doesNotMatch(renderReport(a), /What to do|Replace the predicate with the validated form/);
}
console.log('PASS structural category/actionability; DEFECT correctness+none hides remediation');

// Adaptive fences.
for (const run of [3, 4, 6, 10]) {
  const ticks = '`'.repeat(run);
  const a = base(); a.sql = `SELECT '${ticks}';`; a.ir.originalSql = a.sql;
  a.findings = [finding()]; a.indexes = [index(`CREATE INDEX ix_required ON generic.things (flag); -- ${ticks}`)];
  a.rewrites = [rewrite()]; a.rewrites[0].sql = `SELECT '${ticks}';`;
  const lines = renderReport(a).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const open = /^(`{3,})(?:sql|text)$/.exec(lines[i]); if (!open) continue;
    const close = lines.indexOf(open[1], i + 1); assert.notEqual(close, -1);
    const longest = Math.max(0, ...(lines.slice(i + 1, close).join('\n').match(/`+/g) ?? []).map((x) => x.length));
    assert.ok(open[1].length > longest); i = close;
  }
}
console.log('PASS adaptive 3/4/6/10-backtick fences');

// q10 calibration.
{
  const m = buildModel(healthyAnalysis); const report = renderReport(healthyAnalysis);
  assert.equal(m.verdict.kind, 'clean'); assert.equal(m.issues.length, 0);
  assert.match(report, /NO PERFORMANCE ACTION|Bitmap Index Scan on idx_orders_customer_id/);
  assert.doesNotMatch(report, /## Do this first/);
}
console.log('PASS q10 trap remains no-performance-action optional cleanup');

// Implausible but finite timing ratios remain labeled measured.
for (const [baselineMs, optimizedMs] of [[Number.MAX_VALUE, 1], [100, 1e-10]]) {
  const a = base(); a.verification = { baselineMs, optimizedMs };
  assert.equal(buildModel(a).timing.kind, 'improvement');
  assert.match(renderReport(a), /Measured timing:.*x speedup/);
}
console.log('DEFECT implausible finite ratios still receive measured authority');

// Blocked Markdown line remains unmatched.
{
  const a = base(); a.findings = [finding()]; a.rewrites = [rewrite()];
  const line = renderReport(a).split('\n').find((value) => value.includes('Action blocked')) ?? '';
  assert.equal((line.match(/\*\*/g) ?? []).length, 1);
}
console.log('DEFECT blocked action line still has unmatched Markdown emphasis');

// Current partial pipeline carries absence inside Analysis.
{
  const catalog = JSON.parse(readFileSync(new URL('../../corpus/catalog.json', import.meta.url), 'utf8'));
  const result = analyze('SELECT o.order_id FROM shop.orders o LIMIT 1;', catalog);
  assert.deepEqual(result.analysis.missingModules, ['M2', 'M3', 'M4', 'M5', 'M6']);
  assert.equal(buildModel(result.analysis).verdict.kind, 'incomplete');
}
console.log('PASS current pipeline carries M2-M6 absence inside Analysis');

console.log('all Round-7 known-gap/gate assertions completed');

