/** Round-5 independent M7 probe: q07-like global semanticRiskElsewhere behavior. */
import assert from 'node:assert/strict';

import type { Analysis, Finding, IndexRecommendation, Rewrite } from '../../src/types.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';

const SQL = 'SELECT l.id, r.id FROM generic.left_rows l LEFT JOIN generic.right_rows r ON r.left_id = l.id;';

function finding(
  id: string,
  category: Finding['category'],
  relation: string,
  column: string,
  severity: Finding['severity'] = category === 'correctness' ? 'critical' : 'high',
): Finding {
  return {
    id,
    title: `Finding ${id}`,
    severity,
    category,
    actionability: 'required',
    evidence: { sqlFragment: `${relation}.${column} IS DISTINCT FROM NULL`, relation, column },
    impact: `The ${id} population is semantically material and must be resolved.`,
    remediation: `Resolve ${id} with the product owner.`,
    confidence: 'high',
  };
}

function proposal(id = 'opaque-result-branch', required: string[] = []): Rewrite {
  return {
    id,
    title: `Adopt result branch ${id}`,
    sql: `SELECT '${id}' AS unrelated_result_branch;`,
    rationale: 'Changes a separate output population; wording deliberately shares no finding tokens.',
    equivalence: 'different-semantics',
    equivalenceNotes: 'The output population changes and needs an independent owner decision.',
    requiresIndexes: required,
    priority: 1,
  };
}

function index(id: string, relation: string, column: string): IndexRecommendation {
  return {
    id,
    ddl: `CREATE INDEX physical_${id} ON ${relation} (${column});`,
    table: relation,
    columns: [column],
    method: 'btree',
    columnOrderRationale: 'One key column.',
    serves: [`${relation}.${column} IS DISTINCT FROM NULL`],
    expectedEffect: 'Predicted support for the selected branch.',
    cost: { estimatedSizeNote: 'Unknown size.', writeImpact: 'Adds write maintenance.' },
    priority: 1,
    confidence: 'high',
  };
}

function analysis(findings: Finding[], rewrites: Rewrite[], indexes: IndexRecommendation[] = []): Analysis {
  return {
    sql: SQL,
    catalogName: 'round5-q07-catalog',
    ir: {
      dialect: 'postgres', originalSql: SQL, statementType: 'select', rootBlockId: 'main', bindingErrors: [],
      blocks: [{
        id: 'main', kind: 'select',
        relations: [
          { alias: 'l', source: 'generic.left_rows', kind: 'table', localPredicates: [] },
          { alias: 'r', source: 'generic.right_rows', kind: 'table', localPredicates: [] },
          { alias: 'u', source: 'unrelated.audit_rows', kind: 'table', localPredicates: [] },
        ],
        joins: [], predicates: [],
        projections: [{ sql: 'l.id', columns: [{ alias: 'l', table: 'generic.left_rows', column: 'id' }] }],
        groupBy: [], having: [], orderBy: [], windowFunctions: [], aggregates: [],
      }],
    },
    semantics: {
      headline: 'Round-5 q07-like global-risk probe.',
      steps: [{ title: 'Return rows', detail: 'The intended population is supplied by findings.' }],
      resultShape: { grain: 'selected left/right row', columns: [{ name: 'id', meaning: 'Identifier.' }] },
      caveats: [],
    },
    execution: {
      accessPaths: [], joinStrategies: [], dominantCosts: [], memoryRisks: [], estimationRisks: [],
      scalability: { summary: 'Not relevant to this semantic probe.' },
    },
    findings, indexes, rewrites,
  };
}

function branchOf(input: Analysis, rw: Rewrite) {
  return buildModel(input).issues.find((issue) => issue.rewrites.includes(rw));
}

// q07-like target: one high intent finding and a zero-affinity result branch.
{
  const intent = finding('outer-row-intent', 'intent', 'generic.right_rows', 'state');
  intent.title = 'A right-side condition removes unmatched left rows';
  const rw = proposal('retain-unmatched');
  const input = analysis([intent], [rw]);
  const model = buildModel(input);
  const branch = branchOf(input, rw);
  assert.equal(model.verdict.kind, 'intent-required');
  assert.equal(model.issues[0]?.findings[0], intent);
  assert.equal(branch?.kind, 'intent');
  assert.equal(branch?.semanticRiskElsewhere?.kind, 'intent');
  assert.match(renderReport(input), /intent-confirmation branch, not an automatic repair/);
  console.log('PASS q07-like zero-affinity proposal remains a separate intent-confirmation branch');
}

// The same global rule fires when the sole intent finding is demonstrably about
// an unrelated relation/column. No exact edge or affinity connects the rewrite.
{
  const unrelatedIntent = finding('audit-retention-intent', 'intent', 'unrelated.audit_rows', 'retention_code');
  const rw = proposal('change-customer-population');
  const input = analysis([unrelatedIntent], [rw]);
  const branch = branchOf(input, rw);
  assert.equal(branch?.findingPositions, undefined);
  assert.equal(branch?.findings.length, 0);
  assert.equal(branch?.kind, 'intent');
  assert.equal(branch?.semanticRiskElsewhere?.title, unrelatedIntent.title);
  const report = renderReport(input);
  assert.match(report, /Intent-confirmation branch/);
  assert.match(report, /A material intent finding elsewhere establishes that the population is unsettled/);
  assert.doesNotMatch(report, /not attached to it/);
  console.log('DEFECT unrelated global intent risk gives an opaque result change the same q07 intent-branch framing');
}

// A correctness risk elsewhere gets more cautious prose: it does not claim the
// proposal fixes the defect, and the real correctness issue still leads.
{
  const correctness = finding('unrelated-wrong-result', 'correctness', 'unrelated.audit_rows', 'checksum');
  const rw = proposal('separate-population-change');
  const input = analysis([correctness], [rw]);
  const model = buildModel(input);
  const branch = branchOf(input, rw);
  assert.equal(model.verdict.kind, 'wrong-results');
  assert.equal(model.issues[0]?.findings[0], correctness);
  assert.equal(branch?.kind, 'correctness');
  assert.equal(branch?.semanticChangeJustified, false);
  assert.match(renderReport(input), /this proposal is not attached to it/);
  console.log('PASS correctness elsewhere leads and the unattached result change remains explicitly unproved');
}

// With both categories present, global intent always classifies the orphan
// branch, even though an unrelated correctness defect still owns the verdict.
for (const reverse of [false, true]) {
  const intent = finding('unrelated-intent', 'intent', 'unrelated.audit_rows', 'retention_code');
  const correctness = finding('unrelated-correctness', 'correctness', 'unrelated.audit_rows', 'checksum');
  const rw = proposal(`both-risks-${reverse ? 'reversed' : 'forward'}`);
  const input = analysis(reverse ? [correctness, intent] : [intent, correctness], [rw]);
  const model = buildModel(input);
  const branch = branchOf(input, rw);
  assert.equal(model.verdict.kind, 'wrong-results');
  assert.equal(model.issues[0]?.kind, 'correctness');
  assert.equal(branch?.kind, 'intent');
  assert.equal(branch?.semanticRiskElsewhere?.kind, 'intent');
}
console.log('OBSERVE both correctness+intent: correctness leads, but global intent categorizes the orphan branch in either order');

// Several unrelated intent risks make semanticRiskElsewhere.title depend on
// their input order, although neither has a relationship to the proposal.
{
  const first = finding('first-unrelated-intent', 'intent', 'unrelated.audit_rows', 'retention_code');
  const second = finding('second-unrelated-intent', 'intent', 'unrelated.audit_rows', 'archive_code');
  const rw = proposal('opaque-many-risks');
  const forward = branchOf(analysis([first, second], [rw]), rw);
  const reverse = branchOf(analysis([second, first], [rw]), rw);
  assert.equal(forward?.semanticRiskElsewhere?.title, first.title);
  assert.equal(reverse?.semanticRiskElsewhere?.title, second.title);
  console.log('DEFECT global semanticRiskElsewhere metadata selects the first unrelated intent risk by input order');
}

// With no semantic finding elsewhere, an unattached result change remains a
// low-confidence synthetic correctness warning rather than being sanitized.
{
  const rw = proposal('no-semantic-risk');
  const input = analysis([], [rw]);
  const model = buildModel(input);
  const branch = branchOf(input, rw);
  assert.equal(model.verdict.kind, 'possible-wrong-results');
  assert.equal(branch?.kind, 'correctness');
  assert.equal(branch?.confidence, 'low');
  assert.match(renderReport(input), /No attached correctness finding justifies that change/);
  console.log('PASS no-risk control remains a low-confidence ungrounded result-change warning');
}

// Structural control: an exact-ID component whose index has real affinity to
// the intent finding is attached and justified, not handled by the global rule.
{
  const intent = finding('attached-outer-row-intent', 'intent', 'generic.right_rows', 'state');
  const ix = index('ix_attached_state', 'generic.right_rows', 'state');
  const rw = proposal('attached-retain-unmatched', [ix.id]);
  const input = analysis([intent], [rw], [ix]);
  const branch = branchOf(input, rw);
  assert.ok(branch?.findings.includes(intent));
  assert.equal(branch?.semanticChangeJustified, true);
  assert.equal(branch?.semanticRiskElsewhere, undefined);
  assert.equal(branch?.kind, 'intent');
  assert.match(renderReport(input), /This is an intent branch, not an automatic repair/);
  console.log('PASS structurally attached q07 control uses same-issue intent evidence');
}

console.log('all Round-5 q07/global-risk probe assertions completed');
