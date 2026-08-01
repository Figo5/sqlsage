/**
 * Round-8 independent critic probe: line-comment identity at normal model
 * construction and at the renderer's independent revalidation boundary.
 * All cases run before aggregate assertions.
 */
import assert from 'node:assert/strict';

import type { Analysis, IndexRecommendation } from '../../src/types.ts';
import { recognizeCreateIndexDdl } from '../../src/report/index-ddl.ts';
import { buildModel, renderReport } from '../../src/report/index.ts';

const SQL = 'SELECT t.id FROM generic.things t WHERE t.flag IS TRUE;';

function recommendation(ddl: string): IndexRecommendation {
  return {
    id: 'ix_line_boundary',
    ddl,
    table: 'generic.things',
    columns: ['flag'],
    method: 'btree',
    columnOrderRationale: 'The equality key is first.',
    serves: ['t.flag IS TRUE'],
    expectedEffect: 'Predicted index access for the flag predicate.',
    cost: { estimatedSizeNote: 'Unknown.', writeImpact: 'Adds index maintenance.' },
    priority: 1,
    confidence: 'high',
  };
}

function analysis(index: IndexRecommendation): Analysis {
  return {
    sql: SQL,
    catalogName: 'round8-line-boundary',
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
        projections: [{
          sql: 't.id',
          columns: [{ alias: 't', table: 'generic.things', column: 'id' }],
        }],
        groupBy: [],
        having: [],
        orderBy: [],
        windowFunctions: [],
        aggregates: [],
      }],
    },
    semantics: {
      headline: 'Independent line-boundary rendering probe.',
      steps: [{ title: 'Read flags', detail: 'Return rows matching the flag.' }],
      resultShape: { grain: 'matching thing', columns: [{ name: 'id', meaning: 'Identifier.' }] },
      caveats: [],
    },
    execution: {
      accessPaths: [],
      joinStrategies: [],
      dominantCosts: [],
      memoryRisks: [],
      estimationRisks: [],
      scalability: { summary: 'Not material to this boundary probe.' },
    },
    findings: [{
      id: 'line-boundary-finding',
      title: 'The candidate change requires validated DDL',
      severity: 'high',
      category: 'performance',
      actionability: 'required',
      evidence: { sqlFragment: 't.flag IS TRUE', relation: 'generic.things', column: 'flag' },
      impact: 'The rewrite is deployable only with one complete index statement.',
      remediation: 'Deploy the complete validated change set.',
      confidence: 'high',
    }],
    indexes: [index],
    rewrites: [{
      id: 'line-boundary-rewrite',
      title: 'Use the validated flag form',
      sql: SQL,
      rationale: 'Keeps the predicate shape expected by the index.',
      equivalence: 'exact',
      equivalenceNotes: 'The result multiset is unchanged.',
      requiresIndexes: [index.id],
      priority: 1,
    }],
  };
}

interface Case {
  label: string;
  ddl: string;
  valid: boolean;
}

const endings = [
  { label: 'lf', value: '\n' },
  { label: 'crlf', value: '\r\n' },
  { label: 'cr', value: '\r' },
] as const;

const cases: Case[] = [];
for (const ending of endings) {
  const e = ending.value;
  const s = ending.label;
  cases.push(
    {
      label: `${s}-trailing-comment`,
      ddl: `CREATE INDEX ix_line_boundary ON generic.things (flag); -- trailing${e}`,
      valid: true,
    },
    {
      label: `${s}-payload`,
      ddl: `CREATE INDEX ix_line_boundary ON generic.things (flag); -- comment${e}SELECT FROM;`,
      valid: false,
    },
    {
      label: `${s}-second-index`,
      ddl:
        `CREATE INDEX ix_line_boundary ON generic.things (flag); -- comment${e}` +
        `CREATE INDEX ix_second ON generic.things (flag);`,
      valid: false,
    },
    {
      label: `${s}-string-protected`,
      ddl:
        `CREATE INDEX ix_line_boundary ON generic.things ` +
        `((coalesce(note, '-- comment${e}SELECT FROM;')));`,
      valid: true,
    },
    {
      label: `${s}-dollar-protected`,
      ddl:
        `CREATE INDEX ix_line_boundary ON generic.things ` +
        `((coalesce(note, $x$-- comment${e}SELECT FROM;$x$)));`,
      valid: true,
    },
    {
      label: `${s}-block-protected`,
      ddl:
        `CREATE INDEX ix_line_boundary ON generic.things ` +
        `(flag /* -- comment${e}SELECT FROM; */);`,
      valid: true,
    },
  );
}

const modelFailures: string[] = [];
for (const entry of cases) {
  const input = analysis(recommendation(entry.ddl));
  const recognized = recognizeCreateIndexDdl(entry.ddl).valid;
  const model = buildModel(input);
  const report = renderReport(input);

  if (recognized !== entry.valid) modelFailures.push(`${entry.label}: recognizer=${recognized}`);
  if (entry.valid) {
    if (model.counts.indexes !== 1) modelFailures.push(`${entry.label}: model dropped valid index`);
    if (model.dependencyProblems.length !== 0) modelFailures.push(`${entry.label}: valid dependency blocked`);
    if (!/coupled rewrite \+ index/.test(report)) modelFailures.push(`${entry.label}: coupled action missing`);
    if (!/Before you run it/.test(report)) modelFailures.push(`${entry.label}: build advice missing`);
    if (/DDL rejected|Required index missing/.test(report)) modelFailures.push(`${entry.label}: valid DDL called rejected`);
  } else {
    if (model.counts.indexes !== 0) modelFailures.push(`${entry.label}: invalid index entered model`);
    if (model.dependencyProblems[0]?.reason !== 'missing') modelFailures.push(`${entry.label}: dependency not missing`);
    if (model.verdict.kind !== 'incomplete') modelFailures.push(`${entry.label}: verdict not incomplete`);
    if (!/Required index missing/.test(report)) modelFailures.push(`${entry.label}: missing-index warning absent`);
    if (/coupled rewrite \+ index|Before you run it/.test(report)) {
      modelFailures.push(`${entry.label}: invalid DDL received deployable/action advice`);
    }
    if (/SELECT FROM|CREATE INDEX ix_second/.test(report)) modelFailures.push(`${entry.label}: rejected payload rendered`);
  }
}

// Revalidate every lexical family after model construction by changing only
// the value observed from fixBlocks(). This is the lowest public renderer path.
const renderFailures: string[] = [];
for (const entry of cases) {
  const index = recommendation('CREATE INDEX ix_line_boundary ON generic.things (flag);');
  Object.defineProperty(index, 'ddl', {
    enumerable: true,
    configurable: true,
    get() {
      return new Error().stack?.includes('fixBlocks')
        ? entry.ddl
        : 'CREATE INDEX ix_line_boundary ON generic.things (flag);';
    },
  });
  const report = renderReport(analysis(index));
  if (entry.valid) {
    if (/DDL rejected/.test(report)) renderFailures.push(`${entry.label}: render-time valid DDL rejected`);
    if (!/Before you run it/.test(report)) renderFailures.push(`${entry.label}: render-time advice missing`);
  } else {
    if (!/DDL rejected/.test(report)) renderFailures.push(`${entry.label}: render-time invalid DDL trusted`);
    if (/Before you run it|lets reads continue|performs two table scans/.test(report)) {
      renderFailures.push(`${entry.label}: render-time invalid DDL received lock/build advice`);
    }
    if (/SELECT FROM|CREATE INDEX ix_second/.test(report)) {
      renderFailures.push(`${entry.label}: render-time rejected payload rendered`);
    }
  }
}

console.log(
  `MODEL_MATRIX cases=${cases.length} accepted=${cases.filter((entry) => entry.valid).length} ` +
  `rejected=${cases.filter((entry) => !entry.valid).length} failures=${modelFailures.length}`,
);
for (const failure of modelFailures) console.log(`MODEL_FAIL ${failure}`);
console.log(`RENDER_MATRIX cases=${cases.length} failures=${renderFailures.length}`);
for (const failure of renderFailures) console.log(`RENDER_FAIL ${failure}`);

assert.deepEqual(modelFailures, []);
assert.deepEqual(renderFailures, []);
console.log('PASS all LF/CRLF/CR cases at model construction and independent renderer revalidation');

