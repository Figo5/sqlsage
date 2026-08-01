/** Round-6 independent M7 probe: validation/dependency/rendering DDL defenses. */
import assert from 'node:assert/strict';

import type { Analysis, IndexRecommendation } from '../../src/types.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';

const SQL = 'SELECT t.id FROM generic.things t WHERE t.flag IS TRUE;';

function recommendation(ddl: string): IndexRecommendation {
  return {
    id: 'ix_runtime_boundary',
    ddl,
    table: 'generic.things',
    columns: ['flag'],
    method: 'btree',
    columnOrderRationale: 'One key column.',
    serves: ['t.flag IS TRUE'],
    expectedEffect: 'Predicted index access.',
    cost: { estimatedSizeNote: 'Unknown.', writeImpact: 'Adds write maintenance.' },
    priority: 1,
    confidence: 'high',
  };
}

function analysis(index: IndexRecommendation): Analysis {
  return {
    sql: SQL,
    catalogName: 'round6-render-defense',
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
      headline: 'Critic-authored renderer boundary probe.',
      steps: [{ title: 'Read rows', detail: 'Returns matching identifiers.' }],
      resultShape: { grain: 'matching row', columns: [{ name: 'id', meaning: 'Identifier.' }] },
      caveats: [],
    },
    execution: {
      accessPaths: [], joinStrategies: [], dominantCosts: [], memoryRisks: [], estimationRisks: [],
      scalability: { summary: 'Not material to this probe.' },
    },
    findings: [{
      id: 'flag-access', title: 'Flag access needs a deployable change', severity: 'high',
      category: 'performance', actionability: 'required',
      evidence: { sqlFragment: 't.flag IS TRUE', relation: 'generic.things', column: 'flag' },
      impact: 'The proposed change depends on executable index DDL.',
      remediation: 'Use the complete change set only after validation.', confidence: 'high',
    }],
    indexes: [index],
    rewrites: [{
      id: 'flag-rewrite', title: 'Use the flag formulation', sql: SQL,
      rationale: 'Keeps the exact predicate shape.', equivalence: 'exact',
      equivalenceNotes: 'The result multiset is unchanged.',
      requiresIndexes: [index.id], priority: 1,
    }],
  };
}

// Normal malformed input: validation drops it, exact-ID resolution cannot use
// it, the rewrite blocks, the reason is visible, and destructive payload text
// never appears as a code block or operational advice.
for (const ddl of [
  'DROP TABLE generic.things;',
  '-- TODO: write DDL',
  'CREATE INDEX ix_incomplete',
  'CREATE INDEX ix_smuggled ON generic.things (flag); DROP TABLE generic.things;',
]) {
  const input = analysis(recommendation(ddl));
  const model = buildModel(input);
  assert.equal(model.verdict.kind, 'incomplete', ddl);
  assert.equal(model.counts.indexes, 0, ddl);
  assert.equal(model.dependencyProblems[0]?.reason, 'missing', ddl);
  const report = renderReport(input);
  assert.match(report, /Malformed analyzer input: Index recommendation #1 was ignored.*ddl \(/s, ddl);
  assert.match(report, /Required index missing/, ddl);
  assert.doesNotMatch(report, /coupled rewrite \+ index|Before you run it|lets reads continue|performs two table scans/, ddl);
  assert.equal(report.includes(ddl.trim()), false, `rejected payload was echoed: ${ddl}`);
}
console.log('PASS malformed recommendation is dropped visibly, blocks dependents, and is not echoed as deployable DDL');

// Lowest public path: buildModel/renderReport. A stateful getter makes the DDL
// valid while the model is built, then swaps it before block rendering. This
// simulates invalid data somehow reaching an Issue without editing source.
{
  const index = recommendation('CREATE INDEX ix_runtime_boundary ON generic.things (flag);');
  let reads = 0;
  Object.defineProperty(index, 'ddl', {
    enumerable: true,
    configurable: true,
    get() {
      reads++;
      return reads <= 4
        ? 'CREATE INDEX ix_runtime_boundary ON generic.things (flag);'
        : 'DROP TABLE generic.things;';
    },
  });
  const report = renderReport(analysis(index));
  assert.match(report, /DDL rejected/);
  assert.doesNotMatch(report, /DROP TABLE generic\.things|Before you run it|lets reads continue|performs two table scans/);
  console.log('PASS renderer guard suppresses DDL/locking prose when invalid text reaches an Issue after model validation');
}

// A recognizer false accept defeats every shared defense: dependency formation,
// code rendering and locking advice all trust the same wrong recognition result.
{
  const ddl = 'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WITH (fillfactor 80);';
  const input = analysis(recommendation(ddl));
  const model = buildModel(input);
  assert.equal(model.counts.indexes, 1);
  assert.equal(model.dependencyProblems.length, 0);
  assert.notEqual(model.verdict.kind, 'incomplete');
  const report = renderReport(input);
  assert.match(report, /coupled rewrite \+ index/);
  assert.ok(report.includes(ddl));
  assert.match(report, /A regular `CREATE INDEX` lets reads continue/);
  assert.doesNotMatch(report, /DDL rejected|Malformed analyzer input/);
  console.log('DEFECT shared false acceptance becomes deployable DDL plus M7-authored regular-index locking advice');
}

console.log('all Round-6 renderer-defense assertions completed');
