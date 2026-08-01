/**
 * Round-4 independent M7 probe: structural rewrite/index coupling.
 *
 * This deliberately does not import src/report/fixtures.ts. Every Analysis
 * object below is critic-authored, generic input.
 */
import assert from 'node:assert/strict';

import type { Analysis, Finding, IndexRecommendation, Rewrite, Severity } from '../../src/types.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';

const SQL = 'SELECT a.id FROM alpha.accounts a WHERE a.created_at >= TIMESTAMPTZ \'2026-01-01\';';

function finding(
  id: string,
  relation: string,
  column: string,
  severity: Severity = 'high',
  category: Finding['category'] = 'performance',
): Finding {
  return {
    id,
    title: `Finding ${id}`,
    severity,
    category,
    actionability: 'required',
    evidence: { sqlFragment: `${relation}.${column} IS DISTINCT FROM NULL`, relation, column },
    impact: `Evidence for ${id} establishes a material ${category} concern.`,
    remediation: `Resolve ${id} before deployment.`,
    confidence: 'high',
  };
}

function index(
  id: string,
  relation: string,
  column: string,
  ddl = `CREATE INDEX ${id}_physical ON ${relation} (${column});`,
): IndexRecommendation {
  return {
    id,
    ddl,
    table: relation,
    columns: [column],
    method: 'btree',
    columnOrderRationale: 'One key column.',
    serves: [`${relation}.${column} range`],
    expectedEffect: 'Predicted access-path change; not measured.',
    cost: { estimatedSizeNote: 'Size not measured.', writeImpact: 'Adds write maintenance.' },
    priority: 1,
    confidence: 'high',
  };
}

function rewrite(id: string, required: string[], equivalence: Rewrite['equivalence'] = 'exact'): Rewrite {
  return {
    id,
    title: `Adopt formulation ${id}`,
    sql: `SELECT '${id}' AS critic_probe;`,
    rationale: 'Uses an alternative formulation with no prose shared with a finding.',
    equivalence,
    equivalenceNotes: equivalence === 'different-semantics'
      ? 'The population differs; product intent decides which result is wanted.'
      : 'The result multiset is unchanged.',
    requiresIndexes: required,
    priority: 1,
  };
}

function analysis(
  findings: Finding[],
  indexes: IndexRecommendation[],
  rewrites: Rewrite[],
): Analysis {
  return {
    sql: SQL,
    catalogName: 'critic-generic-catalog',
    ir: {
      dialect: 'postgres',
      originalSql: SQL,
      statementType: 'select',
      rootBlockId: 'main',
      bindingErrors: [],
      blocks: [{
        id: 'main',
        kind: 'select',
        relations: [{ alias: 'a', source: 'alpha.accounts', kind: 'table', localPredicates: [] }],
        joins: [],
        predicates: [],
        projections: [{ sql: 'a.id', columns: [{ alias: 'a', table: 'alpha.accounts', column: 'id' }] }],
        groupBy: [],
        having: [],
        orderBy: [],
        windowFunctions: [],
        aggregates: [],
      }],
    },
    semantics: {
      headline: 'Generic critic-authored coupling probe.',
      steps: [{ title: 'Read accounts', detail: 'Returns matching account identifiers.' }],
      resultShape: { grain: 'matching account', columns: [{ name: 'id', meaning: 'Account identifier.' }] },
      caveats: [],
    },
    execution: {
      accessPaths: [{ relation: 'alpha.accounts', path: 'seq-scan', reason: 'No relevant baseline access path.' }],
      joinStrategies: [],
      dominantCosts: [],
      memoryRisks: [],
      estimationRisks: [],
      scalability: { summary: 'Depends on matching rows.' },
    },
    findings,
    indexes,
    rewrites,
  };
}

function issueSummary(a: Analysis): string {
  const m = buildModel(a);
  return m.issues.map((issue, n) =>
    `${n + 1}:${issue.kind}/${issue.severity} f=[${issue.findings.map((f) => f.id)}] ` +
    `rw=[${issue.rewrites.map((r) => r.id)}] idx=[${issue.indexes.map((i) => i.id)}]`,
  ).join(' | ');
}

// q01-like: there is deliberately no rewrite/finding prose overlap. Exact ID
// plus a structurally attached index must make one deployable first action.
{
  const f = finding('wrapped-temporal-expression', 'alpha.accounts', 'created_at');
  const ix = index('ix_account_range', 'alpha.accounts', 'created_at');
  const rw = rewrite('opaque-reformulation', ['ix_account_range']);
  const a = analysis([f], [ix], [rw]);
  const m = buildModel(a);
  const bundle = m.issues.find((i) => i.rewrites.includes(rw));
  assert.ok(bundle?.indexes.includes(ix));
  assert.equal(m.issues.filter((i) => i.indexes.includes(ix)).length, 1);
  const firstAction = renderReport(a).split('## Do this first\n\n')[1]?.split('\n\n---')[0] ?? '';
  assert.match(firstAction, /coupled rewrite \+ index/);
  assert.match(firstAction, /Adopt formulation opaque-reformulation and create/);
  console.log('PASS q01-zero-prose:', issueSummary(a));
}

// An index attached to no finding should still remain adjacent to its rewrite.
{
  const f = finding('unrelated-customer-rule', 'alpha.customers', 'tier');
  const ix = index('ix_archive_key', 'alpha.archive', 'archive_key');
  const rw = rewrite('archive-reformulation', ['ix_archive_key']);
  const a = analysis([f], [ix], [rw]);
  const bundle = buildModel(a).issues.find((i) => i.rewrites.includes(rw));
  assert.ok(bundle?.indexes.includes(ix));
  assert.match(renderReport(a), /coupled rewrite \+ index/);
  console.log('PASS unattached-index-pair:', issueSummary(a));
}

// Multiple rewrites may depend on the same index. In the orphan case the
// current implementation gives the physical index to only the first rewrite,
// then tells the second that it is "supplied immediately" even though that
// issue contains no index at all.
{
  const ix = index('ix_shared', 'alpha.archive', 'archive_key');
  const rw1 = rewrite('first-consumer', ['ix_shared']);
  const rw2 = rewrite('second-consumer', ['ix_shared']);
  const a = analysis([], [ix], [rw1, rw2]);
  const m = buildModel(a);
  const b1 = m.issues.find((i) => i.rewrites.includes(rw1));
  const b2 = m.issues.find((i) => i.rewrites.includes(rw2));
  assert.equal(b1?.indexes.includes(ix), true);
  assert.equal(b2?.indexes.includes(ix), false);
  assert.equal(m.dependencyProblems.length, 0);
  const report = renderReport(a);
  assert.equal((report.match(/is supplied immediately with this rewrite/g) ?? []).length, 2);
  console.log('DEFECT shared-orphan-index:', issueSummary(a));
  console.log('  second rewrite has no adjacent index but receives the supplied-immediately safety sentence');
}

// The same multiplicity happens to work when the shared index first attached
// to a finding: both reverse edges land in that issue.
{
  const f = finding('archive-access', 'alpha.archive', 'archive_key');
  const ix = index('ix_shared_attached', 'alpha.archive', 'archive_key');
  const rw1 = rewrite('attached-consumer-a', ['ix_shared_attached']);
  const rw2 = rewrite('attached-consumer-b', ['ix_shared_attached']);
  const a = analysis([f], [ix], [rw1, rw2]);
  const bundle = buildModel(a).issues.find((i) => i.findings.includes(f));
  assert.deepEqual(bundle?.rewrites.map((r) => r.id), [rw1.id, rw2.id]);
  assert.deepEqual(bundle?.indexes.map((i) => i.id), [ix.id]);
  console.log('PASS shared-attached-index:', issueSummary(a));
}

// One rewrite, several exact-ID indexes, with one initially attached and one
// initially orphaned. The forward pass correctly pulls both into one bundle.
{
  const f = finding('range-access', 'alpha.accounts', 'created_at');
  const attached = index('ix_range', 'alpha.accounts', 'created_at');
  const orphan = index('ix_payload', 'alpha.payloads', 'payload_key');
  const rw = rewrite('multi-index-form', ['ix_range', 'ix_payload']);
  const a = analysis([f], [attached, orphan], [rw]);
  const bundle = buildModel(a).issues.find((i) => i.rewrites.includes(rw));
  assert.deepEqual(bundle?.indexes.map((i) => i.id), ['ix_range', 'ix_payload']);
  console.log('PASS mixed-attachment-multi-index:', issueSummary(a));

  rw.requiresIndexes = ['ix_range', 'ix_payload', 'ix_missing', '   '];
  const blocked = buildModel(a);
  assert.equal(blocked.verdict.kind, 'incomplete');
  assert.deepEqual(blocked.dependencyProblems.map((p) => p.requiredIndexId), ['ix_missing', '   ']);
  assert.match(renderReport(a), /Required index missing/);
  console.log('PASS mixed-valid-missing-blank-ids: blockers=', blocked.dependencyProblems.map((p) => JSON.stringify(p.requiredIndexId)).join(','));
}

// A rewrite with required indexes that affinity attaches to two separate
// findings is left as a third, index-free issue. Picking the higher-severity
// finding would be an unjustified guess, so refusal is right; splitting the
// declared change set and claiming both companions are adjacent is not.
for (const [label, severities] of [
  ['different-severity', ['critical', 'medium'] as Severity[]],
  ['severity-tie', ['high', 'high'] as Severity[]],
] as const) {
  const fa = finding(`${label}-a`, 'alpha.left_table', 'left_key', severities[0]);
  const fb = finding(`${label}-b`, 'alpha.right_table', 'right_key', severities[1]);
  const ia = index(`${label}_ix_a`, 'alpha.left_table', 'left_key');
  const ib = index(`${label}_ix_b`, 'alpha.right_table', 'right_key');
  // Keep the rewrite slug opaque too: this case is about declared edges only.
  const rw = rewrite(label === 'different-severity' ? 'opaque-dual-target-a' : 'opaque-dual-target-b', [ia.id, ib.id]);
  const a = analysis([fa, fb], [ia, ib], [rw]);
  const m = buildModel(a);
  const bundle = m.issues.find((i) => i.rewrites.includes(rw));
  assert.equal(bundle?.indexes.length, 0);
  assert.equal(m.dependencyProblems.length, 0);
  const report = renderReport(a);
  assert.equal((report.match(/is supplied immediately with this rewrite/g) ?? []).length, 2);
  console.log(`DEFECT split-target-${label}:`, issueSummary(a));
}

// If one required contract ID is duplicated and the two recommendations map
// to different findings, selecting the higher severity (or input order on a
// tie) would hide corrupt producer input. Refusal is the correct behavior.
for (const [label, severities] of [
  ['duplicate-different-severity', ['critical', 'medium'] as Severity[]],
  ['duplicate-severity-tie', ['high', 'high'] as Severity[]],
] as const) {
  const fa = finding(`${label}-left`, 'alpha.left_table', 'left_key', severities[0]);
  const fb = finding(`${label}-right`, 'alpha.right_table', 'right_key', severities[1]);
  const ia = index('ix_duplicate_contract', 'alpha.left_table', 'left_key');
  const ib = index('ix_duplicate_contract', 'alpha.right_table', 'right_key');
  const rw = rewrite(label === 'duplicate-different-severity' ? 'opaque-duplicate-a' : 'opaque-duplicate-b', ['ix_duplicate_contract']);
  const a = analysis([fa, fb], [ia, ib], [rw]);
  const m = buildModel(a);
  assert.equal(m.verdict.kind, 'incomplete');
  assert.equal(m.dependencyProblems[0]?.reason, 'ambiguous');
  assert.equal(m.issues.find((i) => i.rewrites.includes(rw))?.indexes.length, 0);
  assert.match(renderReport(a), /Required index ID ambiguous/);
  console.log(`PASS refuse-duplicate-target-${label}:`, issueSummary(a));
}

// Mixed multi-index neighborhood: one valid ID attached elsewhere, one valid
// orphan, one missing, and one duplicated/ambiguous. Safety blockers are loud,
// but the valid attached dependency is still described as immediately supplied
// even though it remains in another issue.
{
  const fa = finding('mixed-anchor-finding', 'alpha.left_table', 'left_key', 'high');
  const fb = finding('mixed-duplicate-finding', 'alpha.right_table', 'right_key', 'medium');
  const anchor = index('ix_mixed_anchor', 'alpha.left_table', 'left_key');
  const orphan = index('ix_mixed_orphan', 'alpha.archive', 'archive_key');
  const dupA = index('ix_mixed_duplicate', 'alpha.right_table', 'right_key');
  const dupB = index('ix_mixed_duplicate', 'alpha.other_table', 'other_key');
  const rw = rewrite('opaque-mixed-dependencies', [anchor.id, orphan.id, 'ix_mixed_missing', dupA.id]);
  const a = analysis([fa, fb], [anchor, orphan, dupA, dupB], [rw]);
  const m = buildModel(a);
  assert.equal(m.verdict.kind, 'incomplete');
  assert.deepEqual(m.dependencyProblems.map((p) => [p.requiredIndexId, p.reason]), [
    ['ix_mixed_missing', 'missing'],
    ['ix_mixed_duplicate', 'ambiguous'],
  ]);
  const bundle = m.issues.find((i) => i.rewrites.includes(rw));
  assert.deepEqual(bundle?.indexes.map((i) => i.id), ['ix_mixed_orphan']);
  const report = renderReport(a);
  assert.match(report, /Required index missing/);
  assert.match(report, /Required index ID ambiguous/);
  assert.match(report, /`ix_mixed_anchor` is supplied immediately with this rewrite/);
  console.log('DEFECT mixed multi-index valid dependency split despite supplied-immediately claim:', issueSummary(a));
}

// One physical recommendation scores against two cross-category findings. The
// current heuristic silently selects severity, then input order on a severity
// tie. Exact requiresIndexes proves rewrite<->index identity only; it does not
// prove either finding relationship.
for (const [label, firstSeverity, secondSeverity] of [
  ['severity-selects', 'medium', 'critical'],
  ['input-order-tie', 'high', 'high'],
] as const) {
  const perf = finding(`${label}-performance`, 'alpha.accounts', 'created_at', firstSeverity, 'performance');
  const intent = finding(`${label}-intent`, 'alpha.accounts', 'created_at', secondSeverity, 'intent');
  const ix = index(`${label}_ix`, 'alpha.accounts', 'created_at');
  const rw = rewrite(`${label}-rewrite`, [ix.id]);
  const a = analysis([perf, intent], [ix], [rw]);
  const bundle = buildModel(a).issues.find((i) => i.rewrites.includes(rw));
  console.log(`OBSERVE cross-category-${label}: chosen=[${bundle?.findings.map((f) => f.id)}]`, issueSummary(a));
}

// Similar names, physical DDL names, prefixes and prose do not satisfy an ID.
// A valid exact ID does, even when its physical index name is unrelated.
{
  const f = finding('name-similarity', 'alpha.accounts', 'created_at');
  const wrongId = index('ix_contract_extra', 'alpha.accounts', 'created_at', 'CREATE INDEX ix_contract ON alpha.accounts (created_at);');
  const rw = rewrite('name-overlap-rewrite', ['ix_contract']);
  rw.rationale = 'Create ix_contract for alpha.accounts created_at; all prose and DDL tokens overlap.';
  const bad = analysis([f], [wrongId], [rw]);
  assert.equal(buildModel(bad).dependencyProblems[0]?.reason, 'missing');
  assert.doesNotMatch(renderReport(bad), /coupled rewrite \+ index/);

  const exact = index('ix_contract', 'alpha.accounts', 'created_at', 'CREATE INDEX physically_unrelated_name ON alpha.accounts (created_at);');
  const good = analysis([f], [exact], [rw]);
  assert.equal(buildModel(good).dependencyProblems.length, 0);
  assert.match(renderReport(good), /coupled rewrite \+ index/);
  console.log('PASS exact-id-only; DDL name/prefix/prose cannot satisfy identity');
}

// q07-like orphan versus structurally coupled result-changing branches.
{
  const intent = finding('outer-row-intent', 'alpha.orders', 'status', 'high', 'intent');
  intent.title = 'The right-side filter removes unmatched rows';
  intent.impact = 'As written, no left row without a matching complete order survives; product intent is unknown.';
  const orphanRw = rewrite('retain-unmatched', [], 'different-semantics');
  const orphan = analysis([intent], [], [orphanRw]);
  const orphanModel = buildModel(orphan);
  assert.equal(orphanModel.verdict.kind, 'possible-wrong-results');
  assert.equal(orphanModel.issues[0]?.findings.length, 0);
  assert.match(renderReport(orphan), /No attached correctness finding justifies that change/);
  console.log('DEFECT q07-orphan:', issueSummary(orphan), 'verdict=', orphanModel.verdict.label);

  const ix = index('ix_status_branch', 'alpha.orders', 'status');
  const coupledRw = rewrite('retain-unmatched-coupled', [ix.id], 'different-semantics');
  const coupled = analysis([intent], [ix], [coupledRw]);
  const coupledModel = buildModel(coupled);
  assert.equal(coupledModel.verdict.kind, 'intent-required');
  const bundle = coupledModel.issues.find((i) => i.rewrites.includes(coupledRw));
  assert.equal(bundle?.kind, 'intent');
  assert.equal(bundle?.semanticChangeJustified, true);
  assert.match(renderReport(coupled), /intent branch, not an automatic repair/);
  console.log('PASS q07-coupled:', issueSummary(coupled), 'verdict=', coupledModel.verdict.label);
}

console.log('all coupling probe assertions completed');
