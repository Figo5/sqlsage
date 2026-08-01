/** Round-5 independent M7 probe: exact-ID component topology and rendering. */
import assert from 'node:assert/strict';

import type { Analysis, Finding, IndexRecommendation, Rewrite, Severity } from '../../src/types.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';

const SQL = 'SELECT r.id FROM generic.records r WHERE r.flag IS TRUE;';

function finding(
  id: string,
  relation: string,
  column: string,
  category: Finding['category'] = 'performance',
  severity: Severity = 'high',
): Finding {
  return {
    id,
    title: `Finding ${id}`,
    severity,
    category,
    actionability: 'required',
    evidence: { sqlFragment: `${relation}.${column} IS DISTINCT FROM NULL`, relation, column },
    impact: `The ${relation}.${column} behavior establishes the ${category} concern ${id}.`,
    remediation: `Resolve ${id} before deployment.`,
    confidence: 'high',
  };
}

function index(id: string, relation: string, column: string, physical = `physical_${id}`): IndexRecommendation {
  return {
    id,
    ddl: `CREATE INDEX ${physical} ON ${relation} (${column});`,
    table: relation,
    columns: [column],
    method: 'btree',
    columnOrderRationale: 'One key column.',
    serves: [`${relation}.${column} IS DISTINCT FROM NULL`],
    expectedEffect: 'Predicted access-path change; not measured.',
    cost: { estimatedSizeNote: 'Size not measured.', writeImpact: 'Adds write maintenance.' },
    priority: 1,
    confidence: 'high',
  };
}

function rewrite(id: string, requiresIndexes: string[], equivalence: Rewrite['equivalence'] = 'exact'): Rewrite {
  return {
    id,
    title: `Adopt formulation ${id}`,
    sql: `SELECT '${id}' AS round5_component_probe;`,
    rationale: 'Uses an opaque formulation with no finding prose in common.',
    equivalence,
    equivalenceNotes: equivalence === 'different-semantics'
      ? 'The returned population differs; an owner must confirm intent.'
      : 'The result multiset is unchanged.',
    requiresIndexes,
    priority: 1,
  };
}

function analysis(findings: Finding[], indexes: IndexRecommendation[], rewrites: Rewrite[]): Analysis {
  return {
    sql: SQL,
    catalogName: 'round5-generic-catalog',
    ir: {
      dialect: 'postgres', originalSql: SQL, statementType: 'select', rootBlockId: 'main', bindingErrors: [],
      blocks: [{
        id: 'main', kind: 'select',
        relations: [
          { alias: 'r', source: 'generic.records', kind: 'table', localPredicates: [] },
          { alias: 'a', source: 'generic.alpha', kind: 'table', localPredicates: [] },
          { alias: 'b', source: 'generic.beta', kind: 'table', localPredicates: [] },
          { alias: 'c', source: 'generic.gamma', kind: 'table', localPredicates: [] },
        ],
        joins: [], predicates: [],
        projections: [{ sql: 'r.id', columns: [{ alias: 'r', table: 'generic.records', column: 'id' }] }],
        groupBy: [], having: [], orderBy: [], windowFunctions: [], aggregates: [],
      }],
    },
    semantics: {
      headline: 'Round-5 critic-authored exact-ID component probe.',
      steps: [{ title: 'Read records', detail: 'Returns matching identifiers.' }],
      resultShape: { grain: 'matching record', columns: [{ name: 'id', meaning: 'Identifier.' }] },
      caveats: [],
    },
    execution: {
      accessPaths: [{ relation: 'generic.records', path: 'seq-scan', reason: 'No baseline access path supplied.' }],
      joinStrategies: [], dominantCosts: [], memoryRisks: [], estimationRisks: [],
      scalability: { summary: 'Depends on matching rows.' },
    },
    findings, indexes, rewrites,
  };
}

function permutations<T>(values: T[]): T[][] {
  if (values.length <= 1) return [values];
  return values.flatMap((value, i) =>
    permutations([...values.slice(0, i), ...values.slice(i + 1)]).map((rest) => [value, ...rest]),
  );
}

// A -> X <- B -> Y <- C is one connected component under every ordering.
{
  const x = index('ix_chain_x', 'generic.alpha', 'alpha_key');
  const y = index('ix_chain_y', 'generic.beta', 'beta_key');
  const a = rewrite('chain-a', [x.id]);
  const b = rewrite('chain-b', [x.id, y.id]);
  const c = rewrite('chain-c', [y.id]);
  for (const indexOrder of [[x, y], [y, x]]) {
    for (const rewriteOrder of permutations([a, b, c])) {
      const input = analysis([], indexOrder, rewriteOrder);
      const model = buildModel(input);
      const components = model.issues.filter((issue) => issue.rewrites.some((rw) => [a, b, c].includes(rw)));
      assert.equal(components.length, 1);
      assert.deepEqual(new Set(components[0].rewrites.map((rw) => rw.id)), new Set([a.id, b.id, c.id]));
      assert.deepEqual(new Set(components[0].indexes.map((idx) => idx.id)), new Set([x.id, y.id]));
      const report = renderReport(input);
      assert.equal((report.match(/CREATE INDEX physical_ix_chain_x/g) ?? []).length, 1);
      assert.equal((report.match(/CREATE INDEX physical_ix_chain_y/g) ?? []).length, 1);
    }
  }
  console.log('PASS chain/star topology and 12 index/rewrite ordering permutations');
}

// Empty dependency arrays make no edge and no blocker.
{
  const standalone = rewrite('empty-dependency-array', []);
  const input = analysis([], [], [standalone]);
  const model = buildModel(input);
  assert.equal(model.dependencyProblems.length, 0);
  assert.equal(model.issues.find((issue) => issue.rewrites.includes(standalone))?.indexes.length, 0);
  console.log('PASS empty requiresIndexes array remains an unblocked standalone recommendation');
}

// Repeating one exact ID must not duplicate the physical DDL. It currently
// duplicates the M7-authored companion note once per array occurrence.
{
  const ix = index('ix_repeated', 'generic.alpha', 'alpha_key');
  const rw = rewrite('repeated-consumer', [ix.id, ix.id, ix.id]);
  const input = analysis([], [ix], [rw]);
  const model = buildModel(input);
  assert.equal(model.dependencyProblems.length, 0);
  const report = renderReport(input);
  assert.equal((report.match(/CREATE INDEX physical_ix_repeated/g) ?? []).length, 1);
  assert.equal((report.match(/`ix_repeated` is present in this change set/g) ?? []).length, 3);
  console.log('DEFECT repeated exact ID emits the same required-companion note three times (DDL stays unique)');
}

// Two disconnected components may address the same finding. They can share one
// issue, but each exact companion remains present and each physical DDL appears once.
{
  const f = finding('shared-finding', 'generic.alpha', 'alpha_key');
  const x = index('ix_disconnected_x', 'generic.alpha', 'alpha_key');
  const y = index('ix_disconnected_y', 'generic.alpha', 'alpha_key');
  const a = rewrite('disconnected-a', [x.id]);
  const b = rewrite('disconnected-b', [y.id]);
  const input = analysis([f], [x, y], [a, b]);
  const issue = buildModel(input).issues.find((candidate) => candidate.findings.includes(f));
  assert.deepEqual(new Set(issue?.rewrites.map((rw) => rw.id)), new Set([a.id, b.id]));
  assert.deepEqual(new Set(issue?.indexes.map((idx) => idx.id)), new Set([x.id, y.id]));
  const report = renderReport(input);
  assert.equal((report.match(/CREATE INDEX physical_ix_disconnected_x/g) ?? []).length, 1);
  assert.equal((report.match(/CREATE INDEX physical_ix_disconnected_y/g) ?? []).length, 1);
  assert.doesNotMatch(report, /Required index not adjacent/);
  console.log('PASS disconnected components with the same finding keep exact adjacency and unique DDL');
}

// Several rewrites in one valid component own their own blockers. Valid members
// survive; missing, blank, and ambiguous IDs do not create false edges.
{
  const x = index('ix_mixed_x', 'generic.alpha', 'alpha_key');
  const y = index('ix_mixed_y', 'generic.beta', 'beta_key');
  const dupA = index('ix_mixed_dup', 'generic.alpha', 'alpha_key', 'dup_a');
  const dupB = index('ix_mixed_dup', 'generic.beta', 'beta_key', 'dup_b');
  const a = rewrite('mixed-a', [x.id, 'ix_missing']);
  const b = rewrite('mixed-b', [x.id, y.id, '   ']);
  const c = rewrite('mixed-c', [y.id, dupA.id]);
  const input = analysis([], [x, y, dupA, dupB], [a, b, c]);
  const model = buildModel(input);
  const component = model.issues.find((issue) => issue.rewrites.includes(b));
  assert.deepEqual(new Set(component?.rewrites.map((rw) => rw.id)), new Set([a.id, b.id, c.id]));
  assert.deepEqual(new Set(component?.indexes.map((idx) => idx.id)), new Set([x.id, y.id]));
  assert.deepEqual(model.dependencyProblems.map((problem) => [problem.rewriteId, problem.requiredIndexId, problem.reason]), [
    [a.id, 'ix_missing', 'missing'],
    [b.id, '   ', 'missing'],
    [c.id, 'ix_mixed_dup', 'ambiguous'],
  ]);
  const report = renderReport(input);
  assert.equal((report.match(/CREATE INDEX physical_ix_mixed_x/g) ?? []).length, 1);
  assert.equal((report.match(/CREATE INDEX physical_ix_mixed_y/g) ?? []).length, 1);
  assert.match(report, /Required index missing/);
  assert.match(report, /Required index ID ambiguous/);
  assert.doesNotMatch(report, /Required index not adjacent/);
  console.log('PASS several rewrites retain valid component members and receive the right blockers');
}

// Duplicate contract IDs remain ambiguous regardless of recommendation order,
// finding severity, or physical-name similarity.
{
  for (const [leftSeverity, rightSeverity] of [['critical', 'medium'], ['high', 'high']] as Severity[][]) {
    for (const reversed of [false, true]) {
      const leftFinding = finding('duplicate-left', 'generic.alpha', 'alpha_key', 'performance', leftSeverity);
      const rightFinding = finding('duplicate-right', 'generic.beta', 'beta_key', 'performance', rightSeverity);
      const left = index('ix_ambiguous_contract', 'generic.alpha', 'alpha_key', 'same_prefix_left');
      const right = index('ix_ambiguous_contract', 'generic.beta', 'beta_key', 'same_prefix_right');
      const rw = rewrite('duplicate-consumer', ['ix_ambiguous_contract']);
      const input = analysis(
        reversed ? [rightFinding, leftFinding] : [leftFinding, rightFinding],
        reversed ? [right, left] : [left, right],
        [rw],
      );
      const model = buildModel(input);
      assert.equal(model.dependencyProblems[0]?.reason, 'ambiguous');
      assert.equal(model.issues.find((issue) => issue.rewrites.includes(rw))?.indexes.length, 0);
    }
  }
  console.log('PASS duplicate IndexRecommendation.id never resolves by severity, order, or physical-name prefix');
}

// One connected set spans performance, intent, and correctness through different
// exact members. Correctness leads even when it has the lowest severity, while
// category/severity never split or select ownership of the component.
{
  const correctness = finding('component-correctness', 'generic.alpha', 'alpha_key', 'correctness', 'low');
  const intent = finding('component-intent', 'generic.beta', 'beta_key', 'intent', 'critical');
  const performance = finding('component-performance', 'generic.gamma', 'gamma_key', 'performance', 'critical');
  const a = index('ix_category_a', 'generic.alpha', 'alpha_key');
  const b = index('ix_category_b', 'generic.beta', 'beta_key');
  const c = index('ix_category_c', 'generic.gamma', 'gamma_key');
  const ab = rewrite('category-link-ab', [a.id, b.id]);
  const bc = rewrite('category-link-bc', [b.id, c.id]);
  const input = analysis([performance, intent, correctness], [c, a, b], [bc, ab]);
  const model = buildModel(input);
  const component = model.issues.find((issue) => issue.rewrites.includes(ab));
  assert.ok(component?.rewrites.includes(bc));
  assert.deepEqual(new Set(component?.findings.map((f) => f.id)), new Set([correctness.id, intent.id, performance.id]));
  assert.equal(component?.kind, 'correctness');
  assert.equal(component?.severity, 'low', 'performance/intent severity must not leak into correctness severity');
  assert.equal(model.issues[0], component);
  assert.equal(model.verdict.kind, 'wrong-results');
  console.log('PASS connected cross-category set retains every member; actual correctness leads without severity leakage');
}

// Exact identity remains the only dependency edge; DDL name, prefix, identical
// relation/column, and recommendation prose cannot satisfy a different ID.
{
  const misleading = index('ix_contract_extra', 'generic.alpha', 'alpha_key', 'ix_contract');
  misleading.expectedEffect = 'Use ix_contract for the same predicate.';
  const rw = rewrite('similarity-consumer', ['ix_contract']);
  rw.rationale = 'Create ix_contract on generic.alpha(alpha_key).';
  const input = analysis([], [misleading], [rw]);
  const model = buildModel(input);
  assert.equal(model.dependencyProblems[0]?.reason, 'missing');
  assert.equal(model.issues.find((issue) => issue.rewrites.includes(rw))?.indexes.length, 0);
  console.log('PASS DDL name/prefix/prose/relation similarity never forms a dependency edge');
}

console.log('all Round-5 component probe assertions completed');
