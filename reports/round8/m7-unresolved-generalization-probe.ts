/**
 * Round-8 independent critic probe: generalize every known unresolved M7 gap.
 * Defect assertions describe current behavior and make the probe fail if a gap
 * is silently assumed rather than reproduced.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

import type { Analysis, Finding, IndexRecommendation, Rewrite } from '../../src/types.ts';
import { CONN } from '../../src/db.ts';
import { recognizeCreateIndexDdl } from '../../src/report/index-ddl.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';

const SQL = 'SELECT t.id FROM generic.things t WHERE t.flag IS TRUE;';

function base(): Analysis {
  return {
    sql: SQL,
    catalogName: 'round8-unresolved',
    ir: {
      dialect: 'postgres', originalSql: SQL, statementType: 'select', rootBlockId: 'main', bindingErrors: [],
      blocks: [{
        id: 'main', kind: 'select',
        relations: [{ alias: 't', source: 'generic.things', kind: 'table', localPredicates: [] }],
        joins: [], predicates: [],
        projections: [{ sql: 't.id', columns: [{ alias: 't', table: 'generic.things', column: 'id' }] }],
        groupBy: [], having: [], orderBy: [], windowFunctions: [], aggregates: [],
      }],
    },
    semantics: {
      headline: 'Generic critic-authored unresolved-gap probe.',
      steps: [{ title: 'Read rows', detail: 'Return the selected identifiers.' }],
      resultShape: { grain: 'selected thing', columns: [{ name: 'id', meaning: 'Identifier.' }] },
      caveats: [],
    },
    execution: {
      accessPaths: [{ relation: 'generic.things', path: 'seq-scan', reason: 'No supplied index.' }],
      joinStrategies: [],
      dominantCosts: [{ what: 'Scan generic.things', why: 'Every row is inspected.', estimatedShare: 0.8 }],
      memoryRisks: [], estimationRisks: [], scalability: { summary: 'Linear in relation size.' },
    },
    findings: [], indexes: [], rewrites: [],
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'proven-result-defect',
    title: 'A proven result defect',
    severity: 'critical',
    category: 'correctness',
    actionability: 'required',
    evidence: { sqlFragment: 't.flag IS TRUE', relation: 'generic.things', column: 'flag' },
    impact: 'The query returns a provably incorrect population.',
    remediation: 'Run the supplied independent result check and repair the predicate.',
    confidence: 'high',
    ...overrides,
  };
}

function index(ddl = 'CREATE INDEX ix_required ON generic.things (flag);'): IndexRecommendation {
  return {
    id: 'ix_required', ddl, table: 'generic.things', columns: ['flag'], method: 'btree',
    columnOrderRationale: 'The equality key is first.', serves: ['t.flag IS TRUE'],
    expectedEffect: 'Predicted index access.',
    cost: { estimatedSizeNote: 'Unknown.', writeImpact: 'Adds maintenance.' },
    priority: 1, confidence: 'high',
  };
}

function rewrite(overrides: Partial<Rewrite> = {}): Rewrite {
  return {
    id: 'repair-query', title: 'Apply the validated repair', sql: SQL,
    rationale: 'Uses the validated predicate form.', equivalence: 'exact',
    equivalenceNotes: 'The result multiset is unchanged.', requiresIndexes: ['ix_required'], priority: 1,
    ...overrides,
  };
}

const failures: string[] = [];

// 1. Malformed runtime module-presence metadata can still assert completeness.
const malformedModules: Array<{ value: unknown; expectedVerdict: 'clean' | 'incomplete' }> = [
  { value: 'M4', expectedVerdict: 'clean' },
  { value: 42, expectedVerdict: 'clean' },
  { value: null, expectedVerdict: 'clean' },
  { value: { missing: 'M4' }, expectedVerdict: 'clean' },
  { value: [42], expectedVerdict: 'clean' },
  { value: [null, ''], expectedVerdict: 'clean' },
  // A valid string member still gates the report, but the malformed neighbor
  // is silently ignored rather than diagnosed.
  { value: ['M4', 42], expectedVerdict: 'incomplete' },
];
const malformedModuleResults: Array<{
  value: unknown;
  verdict: string;
  categorical: boolean;
  expectedVerdict: 'clean' | 'incomplete';
}> = [];
for (const entry of malformedModules) {
  const input = base() as Analysis & { missingModules: unknown };
  input.missingModules = entry.value;
  const model = buildModel(input as Analysis);
  const report = renderReport(input as Analysis);
  malformedModuleResults.push({
    value: entry.value,
    verdict: model.verdict.kind,
    categorical: /NO ACTION NEEDED|NO PERFORMANCE ACTION/.test(report),
    expectedVerdict: entry.expectedVerdict,
  });
}
if (!malformedModuleResults.every((entry) =>
  entry.verdict === entry.expectedVerdict &&
  (entry.expectedVerdict === 'clean' ? entry.categorical : !entry.categorical)
)) {
  failures.push('malformed missingModules neighborhood no longer reproduces false categorical completeness');
}

// 2. Optional M3 values that are safely omitted/coerced still gate a proven
// correctness finding as if safety-bearing evidence had been rejected.
const recoveredNoiseResults: string[] = [];
for (const mutate of [
  (input: Analysis) => { input.execution.accessPaths[0].path = 'typo' as never; },
  (input: Analysis) => { input.execution.accessPaths[0].estimatedRows = -1; },
  (input: Analysis) => {
    input.execution.joinStrategies = [{ join: 't to u', algorithm: 'typo' as never, reason: 'Unknown.' }];
  },
  (input: Analysis) => { input.execution.dominantCosts[0].estimatedShare = 1.5; },
  (input: Analysis) => {
    input.execution.estimationRisks = [{ where: 'scan', why: 'Unknown.', direction: 'typo' as never }];
  },
]) {
  const input = base();
  input.findings = [finding()];
  mutate(input);
  recoveredNoiseResults.push(buildModel(input).verdict.kind);
}
if (!recoveredNoiseResults.every((kind) => kind === 'incomplete')) {
  failures.push('recovered optional validation noise no longer gates correctness uniformly');
}

// 3. actionability:none hides supplied remediation for both correctness and intent.
const hiddenRemediationResults: Array<{ category: string; hidden: boolean }> = [];
for (const category of ['correctness', 'intent'] as const) {
  const input = base();
  input.findings = [finding({
    category,
    severity: category === 'correctness' ? 'critical' : 'high',
    actionability: 'none',
  })];
  const report = renderReport(input);
  hiddenRemediationResults.push({
    category,
    hidden: !report.includes('Run the supplied independent result check and repair the predicate.'),
  });
}
if (!hiddenRemediationResults.every((entry) => entry.hidden)) {
  failures.push('actionability:none no longer hides all supplied manual remediation');
}

// 4. Implausible but finite timing endpoints still receive measured authority.
const implausibleTimings = [
  [Number.MAX_VALUE, 1],
  [100, 1e-10],
  [1e-10, 100],
  [1e12, 1e-6],
] as const;
const timingResults: Array<{ values: readonly [number, number]; report: string; kind: string }> = [];
for (const values of implausibleTimings) {
  const input = base();
  input.verification = { baselineMs: values[0], optimizedMs: values[1] };
  const model = buildModel(input);
  timingResults.push({ values, report: renderReport(input), kind: model.timing.kind });
}
if (!timingResults.every((entry) =>
  ['improvement', 'regression'].includes(entry.kind) && /Measured (?:timing|regression):.*x (?:speedup|regression)/s.test(entry.report)
)) {
  failures.push('implausible finite timing neighborhood no longer receives measured ratio prose');
}

// 5. Blocked-action emphasis is malformed in Markdown and leaks into terminal.
{
  const input = base();
  input.findings = [finding()];
  input.rewrites = [rewrite()];
  const markdownLine = renderReport(input).split('\n').find((line) => line.includes('Action blocked')) ?? '';
  const terminalLine = renderReport(input, { format: 'terminal', color: false })
    .split('\n').find((line) => line.includes('Action blocked')) ?? '';
  if ((markdownLine.match(/\*\*/g) ?? []).length !== 1 || !terminalLine.includes('**Action blocked')) {
    failures.push('blocked-action unmatched emphasis no longer reproduced in both formats');
  }
}

// 6. Repeating one valid dependency ID duplicates companion prose, not graph/DDL.
{
  const input = base();
  input.findings = [finding({ category: 'performance', severity: 'high' })];
  input.indexes = [index()];
  input.rewrites = [rewrite({ requiresIndexes: ['ix_required', 'ix_required', 'ix_required'] })];
  const report = renderReport(input);
  const noteCount = report.match(/Required companion index/g)?.length ?? 0;
  const ddlCount = report.match(/CREATE INDEX ix_required ON generic\.things/g)?.length ?? 0;
  if (noteCount !== 3 || ddlCount !== 1) failures.push(`repeated ID counts notes=${noteCount}, ddl=${ddlCount}`);
}

// 7. Unrelated global intent still classifies and narrates an opaque result change.
{
  const input = base();
  const unrelated = finding({
    id: 'audit-retention-intent', title: 'Choose an audit retention population',
    category: 'intent', severity: 'high', actionability: 'required',
    evidence: {
      sqlFragment: 'a.retention_code IS DISTINCT FROM NULL',
      relation: 'unrelated.audit_rows', column: 'retention_code',
    },
    impact: 'The audit-retention population needs a product-owner choice.',
    remediation: 'Confirm audit retention with its owner.',
  });
  input.findings = [unrelated];
  input.rewrites = [rewrite({
    id: 'opaque-customer-branch', title: 'Adopt an unrelated customer branch',
    sql: "SELECT 'customer branch';", rationale: 'Changes a separate population.',
    equivalence: 'different-semantics',
    equivalenceNotes: 'Customer output changes and needs an independent decision.',
    requiresIndexes: [],
  })];
  const model = buildModel(input);
  const branch = model.issues.find((issue) => issue.rewrites.some((rw) => rw.id === 'opaque-customer-branch'));
  const report = renderReport(input);
  if (
    branch?.kind !== 'intent' ||
    branch.semanticRiskElsewhere?.title !== unrelated.title ||
    !/A material intent finding elsewhere establishes that the population is unsettled/.test(report)
  ) {
    failures.push('unrelated global intent no longer supplies q07-style branch classification/prose');
  }
}

// 8. Re-run representative live-valid PostgreSQL syntax that remains outside
// the recognizer. These cases are ordinary non-concurrent DDL on a TEMP table.
const liveValidOutsideSubset = [
  {
    label: 'value-less-storage-option',
    ddl: 'CREATE INDEX ix_gap_a ON generic.things (flag) WITH (deduplicate_items);',
    live: 'CREATE INDEX ix_gap_a ON m7_gap_boundary (flag) WITH (deduplicate_items);',
  },
  {
    label: 'positive-signed-storage-value',
    ddl: 'CREATE INDEX ix_gap_b ON generic.things (flag) WITH (fillfactor = +80);',
    live: 'CREATE INDEX ix_gap_b ON m7_gap_boundary (flag) WITH (fillfactor = +80);',
  },
  {
    label: 'signed-exponent-storage-value',
    ddl: 'CREATE INDEX ix_gap_c ON generic.things (flag) WITH (fillfactor = 8e+1);',
    live: 'CREATE INDEX ix_gap_c ON m7_gap_boundary (flag) WITH (fillfactor = 8e+1);',
  },
  {
    label: 'adjacent-dollar-storage-value',
    ddl: 'CREATE INDEX ix_gap_d ON generic.things (flag) WITH (deduplicate_items=$v$on$v$);',
    live: 'CREATE INDEX ix_gap_d ON m7_gap_boundary (flag) WITH (deduplicate_items=$v$on$v$);',
  },
  {
    label: 'column-name-keyword-key',
    ddl: 'CREATE INDEX ix_gap_e ON generic.things (between);',
    live: 'CREATE INDEX ix_gap_e ON m7_gap_boundary (between);',
  },
  {
    label: 'adjacent-dollar-predicate',
    ddl: 'CREATE INDEX ix_gap_f ON generic.things (flag) WHERE note=$q$data$q$;',
    live: 'CREATE INDEX ix_gap_f ON m7_gap_boundary (flag) WHERE note=$q$data$q$;',
  },
  {
    label: 'adjacent-dollar-expression',
    ddl: 'CREATE INDEX ix_gap_g ON generic.things ((payload->>$q$key$q$));',
    live: 'CREATE INDEX ix_gap_g ON m7_gap_boundary ((payload->>$q$key$q$));',
  },
] as const;

const client = new pg.Client(CONN);
await client.connect();
const liveDdlResults: Array<{ label: string; executed: boolean; recognized: boolean; reason: string }> = [];
for (const entry of liveValidOutsideSubset) {
  await client.query('BEGIN');
  await client.query(`
    CREATE TEMP TABLE m7_gap_boundary(
      flag boolean, note text, between text, payload jsonb
    ) ON COMMIT DROP
  `);
  let executed = false;
  try {
    await client.query(entry.live);
    executed = true;
  } finally {
    await client.query('ROLLBACK');
  }
  const recognized = recognizeCreateIndexDdl(entry.ddl);
  liveDdlResults.push({
    label: entry.label,
    executed,
    recognized: recognized.valid,
    reason: recognized.valid ? 'accepted' : recognized.reason,
  });
}
const shopCount = Number((await client.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM pg_indexes WHERE schemaname='shop'",
)).rows[0]?.count);
await client.end();
if (!liveDdlResults.every((entry) => entry.executed && !entry.recognized) || shopCount !== 8) {
  failures.push('representative live-valid conservative-rejection neighborhood changed or database count drifted');
}

console.log(
  `MALFORMED_MODULES variants=${malformedModuleResults.length} ` +
  `categoricalClean=${malformedModuleResults.filter((entry) => entry.verdict === 'clean').length} ` +
  `mixedIncomplete=${malformedModuleResults.filter((entry) => entry.verdict === 'incomplete').length}`,
);
console.log(`RECOVERED_NOISE ${recoveredNoiseResults.length} incomplete-overfire defects`);
console.log(`HIDDEN_REMEDIATION ${hiddenRemediationResults.length} category variants`);
console.log(`IMPLAUSIBLE_TIMINGS ${timingResults.length} measured-ratio defects`);
for (const entry of liveDdlResults) console.log(`SAFE_FALSE_REJECT ${entry.label}: ${entry.reason}`);
console.log(`SHOP_INDEXES ${shopCount}`);
for (const failure of failures) console.log(`FAIL ${failure}`);

assert.deepEqual(failures, []);
console.log('PASS all saved unresolved gaps independently reproduced and generalized');
