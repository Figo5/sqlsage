/**
 * Round-4 independent M7 probe: trust gates, malformed input, actionability,
 * Markdown safety, q10 calibration, and timing plausibility.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import type { Analysis, Finding, IndexRecommendation, Rewrite } from '../../src/types.ts';
import { analyze } from '../../src/index.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';
import { healthyAnalysis } from '../../src/report/fixtures.ts';

function clone<T>(value: T): T {
  return structuredClone(value);
}

const SQL = 'SELECT t.id FROM generic.things t WHERE t.flag = true;';

function base(): Analysis {
  return {
    sql: SQL,
    catalogName: 'critic-catalog',
    ir: {
      dialect: 'postgres',
      originalSql: SQL,
      statementType: 'select',
      rootBlockId: 'main',
      bindingErrors: [],
      blocks: [{
        id: 'main',
        kind: 'select',
        relations: [{ alias: 't', source: 'generic.things', kind: 'table', localPredicates: [] }],
        joins: [],
        predicates: [],
        projections: [{ sql: 't.id', columns: [{ alias: 't', table: 'generic.things', column: 'id' }] }],
        groupBy: [],
        having: [],
        orderBy: [],
        windowFunctions: [],
        aggregates: [],
      }],
    },
    semantics: {
      headline: 'Generic critic-authored report probe.',
      steps: [{ title: 'Read matching rows', detail: 'Returns rows satisfying the flag.' }],
      resultShape: { grain: 'matching thing', columns: [{ name: 'id', meaning: 'Identifier.' }] },
      caveats: [],
    },
    execution: {
      accessPaths: [{ relation: 'generic.things', path: 'seq-scan', reason: 'No supplied index.' }],
      joinStrategies: [],
      dominantCosts: [{ what: 'Scan generic.things', why: 'Every row is inspected.', estimatedShare: 0.8 }],
      memoryRisks: [],
      estimationRisks: [],
      scalability: { summary: 'Linear in table size.' },
    },
    findings: [],
    indexes: [],
    rewrites: [],
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'generic-risk',
    title: 'A proven result defect',
    severity: 'critical',
    category: 'correctness',
    actionability: 'required',
    evidence: { sqlFragment: 't.flag = true', relation: 'generic.things', column: 'flag' },
    impact: 'The query returns a provably incorrect population.',
    remediation: 'Replace the predicate with the validated form.',
    confidence: 'high',
    ...overrides,
  };
}

function index(ddl: string, id = 'ix_required'): IndexRecommendation {
  return {
    id,
    ddl,
    table: 'generic.things',
    columns: ['flag'],
    method: 'btree',
    columnOrderRationale: 'One key column.',
    serves: ['t.flag = true'],
    expectedEffect: 'Predicted index scan.',
    cost: { estimatedSizeNote: 'Unknown size.', writeImpact: 'Adds write maintenance.' },
    priority: 1,
    confidence: 'high',
  };
}

function rewrite(required = ['ix_required']): Rewrite {
  return {
    id: 'repair-query',
    title: 'Apply the validated repair',
    sql: 'SELECT t.id FROM generic.things t WHERE t.flag IS TRUE;',
    rationale: 'Uses the validated form.',
    equivalence: 'different-semantics',
    equivalenceNotes: 'The result differs because the current population is wrong.',
    requiresIndexes: required,
    priority: 1,
  };
}

// Analysis.missingModules integration: proper declarations block; absence,
// empty arrays, and blank-only arrays do not over-fire.
{
  for (const value of [undefined, [], ['', '   ']] as Array<string[] | undefined>) {
    const a = base();
    a.missingModules = value;
    assert.notEqual(buildModel(a).verdict.kind, 'incomplete');
  }
  const declared = base();
  declared.missingModules = [' M4 ', 'M2', 'M4', ''];
  const m = buildModel(declared);
  assert.equal(m.verdict.kind, 'incomplete');
  assert.match(m.verdict.banner, /analyzer modules M2, M4/);
  assert.doesNotMatch(renderReport(declared), /NO ACTION NEEDED|NO PERFORMANCE ACTION/);
  console.log('PASS missingModules valid/absent/empty/blank-only behavior');

  const malformedString = base() as Analysis & { missingModules: unknown };
  malformedString.missingModules = 'M4';
  assert.equal(buildModel(malformedString as Analysis).verdict.kind, 'clean');
  const malformedEntry = base() as Analysis & { missingModules: unknown[] };
  malformedEntry.missingModules = [42];
  assert.equal(buildModel(malformedEntry as Analysis).verdict.kind, 'clean');
  console.log('DEFECT malformed missingModules runtime values are silently treated as completeness assertions');
}

// Hard binding errors gate, warning-only binding does not.
{
  const hard = base();
  hard.findings = [finding()];
  hard.ir.bindingErrors = [{ message: 'Unknown bound column.', severity: 'error' }];
  assert.equal(buildModel(hard).verdict.kind, 'incomplete');
  assert.match(renderReport(hard), /Provisional actions/);

  const warning = base();
  warning.findings = [finding()];
  warning.ir.bindingErrors = [{ message: 'Selectivity is uncertain.', severity: 'warn' }];
  assert.equal(buildModel(warning).verdict.kind, 'wrong-results');
  console.log('PASS hard binding gate without warning-only over-fire');
}

// Six blank safety-critical variants all block categorical output.
{
  const makers: Array<[string, () => Analysis]> = [
    ['finding evidence', () => { const a = base(); a.findings = [finding({ evidence: { sqlFragment: '  \n ' } })]; return a; }],
    ['finding impact', () => { const a = base(); a.findings = [finding({ impact: '\t ' })]; return a; }],
    ['finding remediation', () => { const a = base(); a.findings = [finding({ remediation: '  ' })]; return a; }],
    ['rewrite SQL', () => { const a = base(); a.findings = [finding()]; const rw = rewrite([]); rw.sql = ' \n '; a.rewrites = [rw]; return a; }],
    ['index DDL dependency', () => { const a = base(); a.findings = [finding()]; a.indexes = [index(' \t ')]; a.rewrites = [rewrite()]; return a; }],
    ['original SQL', () => { const a = base(); a.sql = ' \n\t '; return a; }],
  ];
  for (const [label, make] of makers) {
    const m = buildModel(make());
    assert.equal(m.verdict.kind, 'incomplete', label);
  }
  const missingId = base();
  missingId.findings = [finding()];
  missingId.indexes = [index('CREATE INDEX ix_other ON generic.things (flag);', 'ix_other')];
  missingId.rewrites = [rewrite(['ix_required'])];
  assert.equal(buildModel(missingId).verdict.kind, 'incomplete');
  assert.equal(buildModel(missingId).dependencyProblems[0]?.reason, 'missing');
  console.log('PASS all six blank fields plus missing exact-ID dependency gate');
}

// Recovered/cosmetic values are still mixed into the fatal list. These entries
// remain usable after coercion/omission, yet each suppresses WRONG RESULTS.
{
  const pathTypo = base();
  pathTypo.findings = [finding()];
  pathTypo.execution.accessPaths[0].path = 'typo' as never;
  const pathModel = buildModel(pathTypo);
  assert.equal(pathModel.execution?.accessPaths[0]?.path, 'unknown');
  assert.equal(pathModel.verdict.kind, 'incomplete');

  const badShare = base();
  badShare.findings = [finding()];
  badShare.execution.dominantCosts[0].estimatedShare = 1.5;
  const shareModel = buildModel(badShare);
  assert.equal(shareModel.execution?.dominantCosts[0]?.estimatedShare, undefined);
  assert.equal(shareModel.verdict.kind, 'incomplete');
  assert.equal('rejectedProblems' in shareModel, false);
  assert.equal('recoveredProblems' in shareModel, false);
  console.log('DEFECT recovered enum/share noise suppresses categorical correctness; advertised split is not materialized');

  const rejected = base();
  rejected.findings = [{ ...finding(), category: undefined } as never];
  assert.equal(buildModel(rejected).verdict.kind, 'incomplete');
  assert.equal(buildModel(rejected).issues.length, 0);
  console.log('PASS genuinely rejected safety input gates the verdict');
}

// Finding.actionability is structural: scary/action-shaped prose cannot create
// work. Conversely, correctness+none must still present the upstream remedy.
{
  const noAction = base();
  noAction.findings = [finding({
    id: 'prose-cannot-act',
    severity: 'critical',
    category: 'performance',
    actionability: 'none',
    title: 'WRONG RESULTS create an index immediately',
    impact: 'This prose says correctness blocker and severe danger, but the structural category is performance.',
    remediation: 'Immediately rewrite and create three indexes.',
  })];
  const noActionModel = buildModel(noAction);
  assert.equal(noActionModel.verdict.kind, 'clean');
  assert.equal(noActionModel.issues.length, 0);
  assert.doesNotMatch(renderReport(noAction), /## Do this first/);
  console.log('PASS actionability/category are structural; arbitrary prose cannot manufacture an action/verdict');

  const manual = base();
  manual.findings = [finding({ actionability: 'none' })];
  const manualModel = buildModel(manual);
  assert.equal(manualModel.verdict.kind, 'wrong-results');
  assert.equal(manualModel.issues[0]?.actionability, 'none');
  const report = renderReport(manual);
  assert.doesNotMatch(report, /## Do this first|What to do|Replace the predicate with the validated form/);
  console.log('DEFECT correctness+actionability:none drops the only supplied remediation');
}

// Non-CREATE strings are accepted as deployable DDL and inherit M7's own
// CREATE INDEX lock advice.
for (const ddl of ['DROP TABLE generic.things;', '-- TODO: write DDL']) {
  const a = base();
  a.findings = [finding()];
  a.indexes = [index(ddl)];
  a.rewrites = [rewrite()];
  const m = buildModel(a);
  assert.equal(m.dependencyProblems.length, 0);
  assert.notEqual(m.verdict.kind, 'incomplete');
  const report = renderReport(a);
  assert.match(report, /coupled rewrite \+ index/);
  assert.match(report, /A regular `CREATE INDEX` lets reads continue/);
  console.log('DEFECT malformed DDL accepted and receives CREATE INDEX safety prose:', JSON.stringify(ddl));
}

// Adaptive fences: payload runs of 3/4/6/10 backticks stay inside both SQL
// blocks. This parser proves each opening fence is longer than its payload.
{
  for (const run of [3, 4, 6, 10]) {
    const ticks = '`'.repeat(run);
    const a = base();
    a.sql = `SELECT '${ticks}' AS payload;`;
    a.ir.originalSql = a.sql;
    a.findings = [finding()];
    a.indexes = [index(`CREATE INDEX ix_required ON generic.things (flag); -- ${ticks}`)];
    a.rewrites = [rewrite()];
    a.rewrites[0].sql = `SELECT '${ticks}' AS rewritten;`;
    const markdown = renderReport(a);
    const lines = markdown.split('\n');
    let blocks = 0;
    for (let i = 0; i < lines.length; i++) {
      const open = /^(`{3,})(?:sql|text)$/.exec(lines[i]);
      if (!open) continue;
      const close = lines.indexOf(open[1], i + 1);
      assert.notEqual(close, -1);
      const payload = lines.slice(i + 1, close).join('\n');
      const longest = Math.max(0, ...(payload.match(/`+/g) ?? []).map((x) => x.length));
      assert.ok(open[1].length > longest);
      blocks++;
      i = close;
    }
    assert.ok(blocks >= 3);
  }
  console.log('PASS adaptive Markdown fences contain 3/4/6/10-backtick payloads');
}

// q10 remains the deliberate false-positive trap.
{
  const q10 = clone(healthyAnalysis);
  const m = buildModel(q10);
  assert.equal(m.verdict.kind, 'clean');
  assert.equal(m.issues.length, 0);
  const report = renderReport(q10);
  assert.match(report, /NO PERFORMANCE ACTION/);
  assert.match(report, /Bitmap Index Scan on idx_orders_customer_id/);
  assert.match(report, /There is no full scan to avoid, so there is no speedup to win/);
  assert.doesNotMatch(report, /## Do this first|Create .*index/);
  console.log('PASS q10: optional readability only, no promised speedup or action/index');
}

// Finite-only timing sanity accepts absurd ratios as measured evidence.
{
  const overflow = base();
  overflow.verification = { baselineMs: 1, optimizedMs: Number.MIN_VALUE };
  assert.equal(buildModel(overflow).timing.kind, 'unavailable');
  assert.match(renderReport(overflow), /derived timing arithmetic was non-finite/);
  console.log('PASS overflowing derived ratio is unavailable');

  for (const [baselineMs, optimizedMs] of [[Number.MAX_VALUE, 1], [100, 1e-10]]) {
    const a = base();
    a.verification = { baselineMs, optimizedMs };
    const m = buildModel(a);
    assert.equal(m.timing.kind, 'improvement');
    const line = renderReport(a).split('\n').find((s) => s.includes('Measured timing:')) ?? '';
    assert.match(line, /x speedup/);
    console.log('DEFECT absurd finite timing is presented as measured:', line);
  }
}

// The blocked-report safety line still has unmatched bold markup.
{
  const a = base();
  a.findings = [finding()];
  a.rewrites = [rewrite(['ix_absent'])];
  const line = renderReport(a).split('\n').find((s) => s.includes('Action blocked')) ?? '';
  assert.ok(line.startsWith('**Action blocked'));
  assert.equal((line.match(/\*\*/g) ?? []).length, 1);
  console.log('DEFECT blocked safety line has unmatched Markdown bold delimiter:', line);
}

// Producer-to-renderer integration: the current partial pipeline must carry
// missing stages inside Analysis, not rely on a CLI side banner.
{
  const catalog = JSON.parse(readFileSync(new URL('../../corpus/catalog.json', import.meta.url), 'utf8'));
  const result = analyze('SELECT o.order_id FROM shop.orders o LIMIT 1;', catalog);
  assert.deepEqual(result.missingModules, ['M2', 'M3', 'M4', 'M5', 'M6']);
  assert.deepEqual(result.analysis.missingModules, result.missingModules);
  const model = buildModel(result.analysis);
  assert.equal(model.verdict.kind, 'incomplete');
  const report = renderReport(result.analysis);
  assert.match(report, /analyzer modules M2, M3, M4, M5, M6/);
  assert.doesNotMatch(report, /NO ACTION NEEDED|NO PERFORMANCE ACTION/);
  console.log('PASS src/index.ts carries all absent stages into Analysis and M7 blocks the verdict');
}

console.log('all regression probe assertions completed');
