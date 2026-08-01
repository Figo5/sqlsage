/** Round-7 independent M7 probe: model/dependency/rendering behavior at the DDL boundary. */
import assert from 'node:assert/strict';

import type { Analysis, IndexRecommendation } from '../../src/types.ts';
import { recognizeCreateIndexDdl } from '../../src/report/index-ddl.ts';
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
    catalogName: 'round7-render-defense',
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

// Every saved Round-6 grammar false accept now rejects before dependency
// formation and cannot receive executable DDL or index-build prose.
const repaired = [
  'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WITH (fillfactor 80);',
  'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WITH (fillfactor = 80 extra);',
  'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WITH (fillfactor == 80);',
  'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WHERE flag = ANY ();',
  'CREATE INDEX ix_runtime_boundary ON generic.things (flag) INCLUDE (select);',
  'CREATE INDEX ix_runtime_boundary ON generic.things (flag) TABLESPACE select;',
  String.raw`CREATE INDEX ix_runtime_boundary ON generic.things ((U&'\D800'));`,
  String.raw`CREATE INDEX ix_runtime_boundary ON generic.things (U&"fl\D800ag");`,
];
for (const ddl of repaired) {
  const input = analysis(recommendation(ddl));
  const model = buildModel(input);
  assert.equal(model.counts.indexes, 0, ddl);
  assert.equal(model.dependencyProblems[0]?.reason, 'missing', ddl);
  assert.equal(model.verdict.kind, 'incomplete', ddl);
  const report = renderReport(input);
  assert.match(report, /Malformed analyzer input/, ddl);
  assert.match(report, /Required index missing/, ddl);
  assert.equal(report.includes(ddl), false, ddl);
  assert.doesNotMatch(report, /coupled rewrite \+ index|Before you run it|lets reads continue|performs two table scans/, ddl);
}
console.log(`PASS all ${repaired.length} saved grammar false accepts reject before dependency/rendering/advice`);

// Ordinary arbitrary payload defenses remain intact.
for (const ddl of [
  'DROP TABLE generic.things;',
  '-- TODO: write DDL',
  'CREATE INDEX ix_incomplete',
  'CREATE INDEX ix_smuggled ON generic.things (flag); SELECT FROM;',
]) {
  const input = analysis(recommendation(ddl));
  const model = buildModel(input);
  assert.equal(model.counts.indexes, 0, ddl);
  assert.equal(model.dependencyProblems[0]?.reason, 'missing', ddl);
  const report = renderReport(input);
  assert.doesNotMatch(report, /Before you run it|lets reads continue|performs two table scans/, ddl);
}
console.log('PASS ordinary non-index/comment/incomplete/multi-statement defenses remain intact');

// New lexical false accept: PostgreSQL treats bare CR as the end of a -- line
// comment. M7 treats the remainder as comment text, so a second statement
// satisfies the dependency and receives regular-index operational advice.
{
  const ddl = 'CREATE INDEX ix_runtime_boundary ON generic.things (flag); -- comment\rSELECT FROM;';
  assert.equal(recognizeCreateIndexDdl(ddl).valid, true);
  const input = analysis(recommendation(ddl));
  const model = buildModel(input);
  assert.equal(model.counts.indexes, 1);
  assert.equal(model.dependencyProblems.length, 0);
  assert.notEqual(model.verdict.kind, 'incomplete');
  const report = renderReport(input);
  assert.match(report, /coupled rewrite \+ index/);
  assert.match(report, /CREATE INDEX ix_runtime_boundary/);
  assert.match(report, /SELECT FROM/);
  assert.match(report, /A regular `CREATE INDEX` lets reads continue/);
  assert.doesNotMatch(report, /DDL rejected|Malformed analyzer input/);
  assert.equal(report.includes('\r'), false, 'renderer makes the CR visible but still trusts the payload');
  assert.match(report, /\\x0DSELECT FROM/);
  console.log('DEFECT bare-CR comment boundary satisfies dependency and receives CREATE INDEX advice');
}

// Independent render-time revalidation remains real for input that changes
// after model construction.
{
  const index = recommendation('CREATE INDEX ix_runtime_boundary ON generic.things (flag);');
  Object.defineProperty(index, 'ddl', {
    enumerable: true,
    configurable: true,
    get() {
      return new Error().stack?.includes('fixBlocks')
        ? 'DROP TABLE generic.things;'
        : 'CREATE INDEX ix_runtime_boundary ON generic.things (flag);';
    },
  });
  const report = renderReport(analysis(index));
  assert.match(report, /DDL rejected/);
  assert.doesNotMatch(report, /DROP TABLE generic\.things|Before you run it|lets reads continue|performs two table scans/);
}
console.log('PASS independent stateful renderer revalidation remains intact');

// Safe rejection is preferable to false deployment, but the report must not
// misdescribe legitimate PostgreSQL grammar as invalid syntax. The parser
// fallback currently does so for several valid forms.
for (const [ddl, expectedReason] of [
  ['CREATE INDEX ix_runtime_boundary ON generic.things (flag bool_ops (foo = 1));', /not valid PostgreSQL syntax/],
  ['CREATE INDEX ix_runtime_boundary ON generic.things (between);', /empty or incomplete/],
  ['CREATE INDEX ix_runtime_boundary ON generic.things (flag) WHERE note=$q$data$q$;', /empty, incomplete, or unbalanced/],
] as const) {
  const report = renderReport(analysis(recommendation(ddl)));
  assert.match(report, /Malformed analyzer input/);
  assert.match(report, expectedReason);
}
for (const ddl of [
  String.raw`CREATE INDEX ix_runtime_boundary ON generic.things ((E'data\x21'));`,
  String.raw`CREATE INDEX ix_runtime_boundary ON generic.things (U&"fl!0061g" UESCAPE '!');`,
]) {
  const report = renderReport(analysis(recommendation(ddl)));
  assert.match(report, /outside the supported CREATE INDEX subset/);
  assert.doesNotMatch(report, /not valid PostgreSQL syntax/);
}
console.log('DEFECT some safe false rejects are reported as invalid PostgreSQL syntax; E/U rejections are calibrated as unsupported subset');

console.log('all Round-7 renderer-boundary assertions completed');
