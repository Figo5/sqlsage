import assert from 'node:assert/strict';
import test from 'node:test';

import type { Analysis, Finding, IndexRecommendation, Rewrite, Severity } from '../types.ts';
import { recognizeCreateIndexDdl } from './index-ddl.ts';
import { buildModel, renderReport } from './index.ts';
import {
  FIXTURES,
  degradedAnalysis,
  fanOutAnalysis,
  healthyAnalysis,
  nonSargableAnalysis,
} from './fixtures.ts';

const ANSI = /\u001b\[[0-9;]*m/g;
const PLACEHOLDER = /\b(?:undefined|NaN)\b|\[object Object\]/;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function focusedAnalysis(finding: Finding): Analysis {
  const analysis = clone(healthyAnalysis);
  analysis.findings = [finding];
  analysis.indexes = [];
  analysis.rewrites = [];
  analysis.semantics.caveats = [];
  analysis.verification = undefined;
  return analysis;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 'generic-finding',
    title: 'A material query issue',
    severity: 'high',
    category: 'performance',
    actionability: 'required',
    evidence: { sqlFragment: 'SELECT expression' },
    impact: 'The supplied evidence establishes a material impact.',
    remediation: 'Review the expression and apply the supplied repair.',
    confidence: 'high',
    ...overrides,
  };
}

function componentFinding(
  id: string,
  relation: string,
  column: string,
  severity: Severity = 'high',
  category: Finding['category'] = 'performance',
): Finding {
  return finding({
    id,
    title: `Finding ${id}`,
    severity,
    category,
    evidence: { sqlFragment: `${relation}.${column} IS DISTINCT FROM NULL`, relation, column },
    impact: `Structured evidence establishes a material ${category} concern for ${id}.`,
    remediation: `Resolve ${id} before deployment.`,
  });
}

function physicalIndexName(id: string): string {
  return `physical_${id.replace(/[^a-zA-Z0-9_$]/g, '_')}`;
}

function componentIndex(id: string, relation: string, column: string): IndexRecommendation {
  return {
    id,
    ddl: `CREATE INDEX ${physicalIndexName(id)} ON ${relation} (${column});`,
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

function componentRewrite(
  id: string,
  requiresIndexes: string[],
  equivalence: Rewrite['equivalence'] = 'exact',
): Rewrite {
  return {
    id,
    title: `Adopt formulation ${id}`,
    sql: `SELECT '${id}' AS generic_component_test;`,
    rationale: 'Uses an alternative formulation with no finding prose in common.',
    equivalence,
    equivalenceNotes: equivalence === 'different-semantics'
      ? 'The returned population differs; product intent decides which result is wanted.'
      : 'The result multiset is unchanged.',
    requiresIndexes,
    priority: 1,
  };
}

function componentAnalysis(
  findings: Finding[],
  indexes: IndexRecommendation[],
  rewrites: Rewrite[],
): Analysis {
  const analysis = clone(healthyAnalysis);
  analysis.findings = findings;
  analysis.indexes = indexes;
  analysis.rewrites = rewrites;
  analysis.semantics.caveats = [];
  analysis.verification = undefined;
  return analysis;
}

function assertAdaptiveFences(markdown: string): number {
  const lines = markdown.split('\n');
  let blocks = 0;
  for (let i = 0; i < lines.length; i++) {
    const opening = /^(`{3,})(?:sql|text)$/.exec(lines[i]);
    if (!opening) continue;
    const fence = opening[1];
    const closing = lines.indexOf(fence, i + 1);
    assert.notEqual(closing, -1, `fence opened on line ${i + 1} must close`);
    const payload = lines.slice(i + 1, closing).join('\n');
    const longest = Math.max(0, ...(payload.match(/`+/g) ?? []).map((run) => run.length));
    assert.ok(fence.length > longest, `fence length ${fence.length} must exceed payload run ${longest}`);
    blocks++;
    i = closing;
  }
  return blocks;
}

test('all fixtures render deterministically without placeholder values', () => {
  for (const { name, analysis } of FIXTURES) {
    const first = renderReport(analysis, { format: 'markdown' });
    const second = renderReport(analysis, { format: 'markdown' });
    assert.equal(first, second, `${name} should be deterministic`);
    assert.doesNotMatch(first, PLACEHOLDER, `${name} should not leak placeholder values`);
  }
});

test('result grain accepts both noun phrases and complete M2 sentences', () => {
  const nounPhrase = clone(healthyAnalysis);
  nounPhrase.semantics.resultShape.grain = 'customer';
  assert.match(renderReport(nounPhrase), /\*\*Result grain\.\*\* One row per customer\./);

  const completeSentence = clone(healthyAnalysis);
  completeSentence.semantics.resultShape.grain = 'One row per qualifying customer.';
  const completeReport = renderReport(completeSentence);
  assert.match(completeReport, /\*\*Result grain\.\*\* One row per qualifying customer\./);
  assert.doesNotMatch(completeReport, /One row per One row per/i);

  const boundedSentence = clone(healthyAnalysis);
  boundedSentence.semantics.resultShape.grain = 'At most one row for the requested key';
  assert.match(renderReport(boundedSentence), /\*\*Result grain\.\*\* At most one row for the requested key\./);
});

test('correctness leads and related findings are clustered around their fix', () => {
  const model = buildModel(fanOutAnalysis);
  assert.equal(model.verdict.kind, 'wrong-results');
  assert.equal(model.issues[0]?.kind, 'correctness');
  assert.ok(model.issues[0]?.findings.some((finding) => finding.id === 'join-fanout-multiplies-aggregate-input'));
  assert.ok(model.issues[0]?.rewrites.some((rewrite) => rewrite.id === 'pre-aggregate-order-items'));

  const report = renderReport(fanOutAnalysis, { format: 'markdown' });
  assert.ok(report.indexOf('WRONG RESULTS') < report.indexOf('## Do this first'));
});

test('a rewrite stays in the same issue as the index it explicitly requires', () => {
  const model = buildModel(nonSargableAnalysis);
  const issue = model.issues.find((candidate) =>
    candidate.rewrites.some((rewrite) => rewrite.id === 'half-open-range-on-raw-column'),
  );
  assert.ok(issue);
  assert.ok(issue.indexes.some((index) => index.id === 'idx_orders_status_created_at_incl'));

  const report = renderReport(nonSargableAnalysis, { format: 'markdown' });
  assert.match(report, /coupled rewrite \+ index/);
  assert.match(report, /index alone measured 113\.3 ms/i);
});

// Regression, Round 3 M7 BIGGEST_GAP. The test above passed while this bug was live:
// its rewrite echoes the finding's wording, so fuzzy affinity attached it and the
// declared edge was never exercised. Strip the prose overlap and only the structural
// `requiresIndexes` edge is left to do the work. Before the fix the rewrite orphaned
// into a step of its own, putting "create the index" first -- and that index alone
// measures 1.04x SLOWER than baseline. The pair is what earns 3.94x.
test('declared requiresIndexes couples a rewrite whose prose does not match the finding', () => {
  const analysis = clone(nonSargableAnalysis);
  const rewrite = analysis.rewrites.find((r) => r.id === 'half-open-range-on-raw-column');
  assert.ok(rewrite);
  assert.deepEqual(rewrite.requiresIndexes, ['idx_orders_status_created_at_incl']);

  // Same SQL and same declared dependency; nothing left for prose matching to latch on.
  rewrite.id = 'unrelated-slug';
  rewrite.title = 'Adopt the alternative formulation';
  rewrite.rationale = 'Avoids the wrapper so the planner can use an ordered structure.';
  rewrite.equivalenceNotes = 'Returns the same multiset.';

  const model = buildModel(analysis);
  assert.equal(model.verdict.kind, 'needs-work', 'a low intent caveat must not inherit the component performance severity');
  const issue = model.issues.find((c) => c.rewrites.some((r) => r.id === 'unrelated-slug'));
  assert.ok(issue, 'rewrite orphaned into its own issue instead of joining its index');
  assert.ok(issue.indexes.some((i) => i.id === 'idx_orders_status_created_at_incl'));

  // The index must not also survive as an independent first step elsewhere.
  const strays = model.issues.filter(
    (c) => c !== issue && c.indexes.some((i) => i.id === 'idx_orders_status_created_at_incl'),
  );
  assert.equal(strays.length, 0);
  const report = renderReport(analysis, { format: 'markdown' });
  const firstActions = report.split('## Do this first\n\n')[1]?.split('\n\n---')[0] ?? '';
  assert.match(firstActions, /^1\. .*coupled rewrite \+ index/m);
  assert.doesNotMatch(firstActions, /^1\. \*\*Create/m);
});

// The coupling repair must stay a structural fact, not a guess. A requirement that
// points at two different findings is ambiguous, and inventing an answer there would
// reintroduce exactly the kind of confident-wrong placement this gap was about.
test('an ambiguous index requirement does not force a coupling', () => {
  const analysis = clone(nonSargableAnalysis);
  const rewrite = analysis.rewrites.find((r) => r.id === 'half-open-range-on-raw-column');
  assert.ok(rewrite);
  rewrite.requiresIndexes = ['no-such-index-id'];
  rewrite.id = 'unrelated-slug';
  rewrite.title = 'Adopt the alternative formulation';
  rewrite.rationale = 'Avoids the wrapper so the planner can use an ordered structure.';
  rewrite.equivalenceNotes = 'Returns the same multiset.';

  const model = buildModel(analysis);
  const issue = model.issues.find((c) => c.rewrites.some((r) => r.id === 'unrelated-slug'));
  assert.ok(issue);
  assert.ok(!issue.indexes.some((i) => i.id === 'idx_orders_status_created_at_incl'));
});

test('two orphan rewrites sharing one exact-ID index render as one change set', () => {
  const shared = componentIndex('ix_shared_contract', 'generic.archive', 'archive_key');
  const first = componentRewrite('first-consumer', [shared.id]);
  const second = componentRewrite('second-consumer', [shared.id]);
  const analysis = componentAnalysis([], [shared], [first, second]);

  const model = buildModel(analysis);
  assert.equal(model.dependencyProblems.length, 0);
  const bundles = model.issues.filter((issue) =>
    issue.rewrites.includes(first) || issue.rewrites.includes(second) || issue.indexes.includes(shared),
  );
  assert.equal(bundles.length, 1);
  assert.deepEqual(bundles[0].rewrites.map((rw) => rw.id), [first.id, second.id]);
  assert.deepEqual(bundles[0].indexes.map((idx) => idx.id), [shared.id]);

  const report = renderReport(analysis);
  assert.equal((report.match(/CREATE INDEX physical_ix_shared_contract/g) ?? []).length, 1);
  assert.equal((report.match(/`ix_shared_contract` is present in this change set/g) ?? []).length, 2);
  assert.doesNotMatch(report, /supplied immediately|Required index not adjacent/);
});

test('a multi-index rewrite spanning findings keeps every member together without severity ownership', () => {
  for (const [label, severities] of [
    ['different-severity', ['critical', 'medium'] as Severity[]],
    ['severity-tie', ['high', 'high'] as Severity[]],
  ] as const) {
    const leftFinding = componentFinding(`${label}-left`, 'generic.left_records', 'left_key', severities[0]);
    const rightFinding = componentFinding(`${label}-right`, 'generic.right_records', 'right_key', severities[1]);
    const leftIndex = componentIndex(`${label}_left_index`, 'generic.left_records', 'left_key');
    const rightIndex = componentIndex(`${label}_right_index`, 'generic.right_records', 'right_key');
    const rewrite = componentRewrite(
      label === 'different-severity' ? 'opaque-dual-target-a' : 'opaque-dual-target-b',
      [leftIndex.id, rightIndex.id],
    );
    const analysis = componentAnalysis([leftFinding, rightFinding], [leftIndex, rightIndex], [rewrite]);

    const model = buildModel(analysis);
    const bundle = model.issues.find((issue) => issue.rewrites.includes(rewrite));
    assert.ok(bundle, label);
    assert.deepEqual(new Set(bundle.findings.map((entry) => entry.id)), new Set([leftFinding.id, rightFinding.id]), label);
    assert.deepEqual(bundle.indexes.map((idx) => idx.id), [leftIndex.id, rightIndex.id], label);
    assert.equal(model.issues.filter((issue) => issue.indexes.some((idx) => idx === leftIndex || idx === rightIndex)).length, 1, label);
    assert.equal(model.dependencyProblems.length, 0, label);

    const report = renderReport(analysis);
    assert.equal((report.match(new RegExp(`CREATE INDEX ${physicalIndexName(leftIndex.id)}`, 'g')) ?? []).length, 1, label);
    assert.equal((report.match(new RegExp(`CREATE INDEX ${physicalIndexName(rightIndex.id)}`, 'g')) ?? []).length, 1, label);
    assert.match(report, new RegExp(`\`${leftIndex.id}\` is present in this change set`), label);
    assert.match(report, new RegExp(`\`${rightIndex.id}\` is present in this change set`), label);
  }
});

test('mixed valid, missing, blank, and duplicate IDs retain valid component members and block the rest', () => {
  const anchorFinding = componentFinding('anchor-finding', 'generic.left_records', 'left_key');
  const duplicateFinding = componentFinding('duplicate-finding', 'generic.right_records', 'right_key', 'medium');
  const anchor = componentIndex('ix_valid_anchor', 'generic.left_records', 'left_key');
  const orphan = componentIndex('ix_valid_orphan', 'generic.archive', 'archive_key');
  const duplicateA = componentIndex('ix_ambiguous', 'generic.right_records', 'right_key');
  const duplicateB = componentIndex('ix_ambiguous', 'generic.other_records', 'other_key');
  const rewrite = componentRewrite('opaque-mixed-set', [
    anchor.id,
    orphan.id,
    'ix_missing',
    '   ',
    duplicateA.id,
  ]);
  const analysis = componentAnalysis(
    [anchorFinding, duplicateFinding],
    [anchor, orphan, duplicateA, duplicateB],
    [rewrite],
  );

  const model = buildModel(analysis);
  assert.equal(model.verdict.kind, 'incomplete');
  assert.deepEqual(model.dependencyProblems.map((problem) => [problem.requiredIndexId, problem.reason]), [
    ['ix_missing', 'missing'],
    ['   ', 'missing'],
    ['ix_ambiguous', 'ambiguous'],
  ]);
  const bundle = model.issues.find((issue) => issue.rewrites.includes(rewrite));
  assert.ok(bundle);
  assert.deepEqual(bundle.indexes.map((idx) => idx.id), [anchor.id, orphan.id]);
  assert.equal(model.issues.filter((issue) => issue.indexes.includes(anchor)).length, 1);
  assert.equal(model.issues.filter((issue) => issue.indexes.includes(orphan)).length, 1);

  const report = renderReport(analysis);
  assert.match(report, /Required index missing/);
  assert.match(report, /Required index ID ambiguous/);
  assert.match(report, /`ix_valid_anchor` is present in this change set/);
  assert.match(report, /`ix_valid_orphan` is present in this change set/);
  assert.doesNotMatch(report, /`ix_missing` is present in this change set|`ix_ambiguous` is present in this change set/);
  assert.doesNotMatch(report, /Required index not adjacent/);
});

test('a zero-affinity result-changing proposal remains an intent-confirmation branch', () => {
  const intent = componentFinding('outer-row-intent', 'generic.orders', 'state', 'high', 'intent');
  intent.title = 'A right-side condition removes unmatched rows';
  intent.impact = 'The current population excludes unmatched rows, and product intent is unresolved.';
  const proposal = componentRewrite('retain-unmatched', [], 'different-semantics');
  const analysis = componentAnalysis([intent], [], [proposal]);

  const model = buildModel(analysis);
  assert.equal(model.verdict.kind, 'intent-required');
  assert.equal(model.issues[0]?.findings[0]?.id, intent.id);
  const branch = model.issues.find((issue) => issue.rewrites.includes(proposal));
  assert.ok(branch);
  assert.equal(branch.kind, 'intent');
  assert.equal(branch.semanticChangeJustified, false);
  assert.equal(branch.semanticRiskElsewhere?.kind, 'intent');
  assert.match(branch.title, /^Intent-confirmation branch/);
  assert.equal(model.issues.some((issue) => issue.kind === 'correctness'), false);

  const report = renderReport(analysis);
  assert.match(report, /INTENT REQUIRED/);
  assert.match(report, /intent-confirmation branch, not an automatic repair/);
  assert.doesNotMatch(report, /Unjustified result-changing rewrite|No attached correctness finding justifies/);
});

// A module that never ran contributes no findings, which looks exactly like a module
// that ran and found nothing. q06 inflates revenue by exactly 3.0000x and rendered as
// "NO ACTION NEEDED ... in the complete analysis" for precisely this reason.
test('declared missing analyzer modules block any categorical verdict', () => {
  const healthy = buildModel(healthyAnalysis);
  assert.notEqual(healthy.verdict.kind, 'incomplete');

  const partial = clone(healthyAnalysis);
  partial.missingModules = ['M4', 'M2'];
  const model = buildModel(partial);
  assert.equal(model.verdict.kind, 'incomplete');
  assert.equal(model.verdict.label, 'ANALYSIS INCOMPLETE');
  assert.match(model.verdict.banner, /analyzer modules M2, M4/);

  const report = renderReport(partial, { format: 'markdown' });
  assert.doesNotMatch(report, /NO ACTION NEEDED|NO PERFORMANCE ACTION/);

  // An empty or blank list is an assertion of completeness, not a silent trigger.
  for (const value of [[], ['', '   ']]) {
    const clean = clone(healthyAnalysis);
    clean.missingModules = value;
    assert.notEqual(buildModel(clean).verdict.kind, 'incomplete');
  }
});

test('declared product-scope blockers prevent clean verdicts', () => {
  const analysis = clone(healthyAnalysis);
  analysis.blockedReasons = ['only SELECT statements are supported; received delete'];
  const model = buildModel(analysis);
  assert.equal(model.verdict.kind, 'incomplete');
  assert.match(model.verdict.banner, /only SELECT statements are supported/);
  const report = renderReport(analysis);
  assert.match(report, /ANALYSIS INCOMPLETE/);
  assert.doesNotMatch(report, /NO PERFORMANCE ACTION|NO ACTION NEEDED/);
});

test('healthy reports do not manufacture actions from no-change observations', () => {
  const model = buildModel(healthyAnalysis);
  assert.equal(model.verdict.kind, 'clean');
  assert.equal(model.issues.length, 0);
  assert.equal(model.optional.length, 1);

  const report = renderReport(healthyAnalysis, { format: 'markdown' });
  assert.doesNotMatch(report, /## Do this first/);
  assert.match(report, /Optional, low-priority changes/);
  assert.match(report, /effectively unchanged/);
});

test('missing analyzer stages render as incomplete, never healthy', () => {
  const model = buildModel({} as Analysis);
  assert.equal(model.verdict.kind, 'incomplete');

  const report = renderReport({} as Analysis, { format: 'terminal', color: false });
  assert.match(report, /ANALYSIS INCOMPLETE/);
  assert.doesNotMatch(report, /NO ACTION NEEDED/);
  assert.doesNotMatch(report, PLACEHOLDER);
});

test('terminal colour changes styling only and narrow prose stays wrapped', () => {
  for (const { name, analysis } of FIXTURES) {
    const plain = renderReport(analysis, { format: 'terminal', color: false });
    const colored = renderReport(analysis, { format: 'terminal', color: true });
    assert.equal(colored.replace(ANSI, ''), plain, `${name} should have colour-invariant content`);
    assert.doesNotMatch(plain, /\u001b/);
  }

  const narrow = renderReport(degradedAnalysis, { format: 'terminal', color: false, width: 40 });
  for (const [line, text] of narrow.split('\n').entries()) {
    // Executable SQL is intentionally not hard-wrapped because inserting
    // newlines would change copy/paste content.
    if (text.startsWith('    ')) continue;
    assert.ok(text.length <= 40, `line ${line + 1} exceeds requested width: ${text}`);
  }
});

test('maxActions is bounded and can suppress the first-screen action list', () => {
  const none = renderReport(fanOutAnalysis, { format: 'markdown', maxActions: 0 });
  assert.doesNotMatch(none, /## Do this first/);

  const one = renderReport(fanOutAnalysis, { format: 'markdown', maxActions: 1 });
  const actionSection = one.split('## Do this first\n\n')[1]?.split('\n\n---')[0] ?? '';
  assert.match(actionSection, /^1\. /m);
  assert.doesNotMatch(actionSection, /^2\. /m);
});

test('an unexplained verification mismatch blocks a healthy verdict', () => {
  const analysis = clone(healthyAnalysis);
  analysis.findings = [];
  analysis.rewrites = [];
  analysis.verification = { baselineMs: 6.4, optimizedMs: 6.2, resultsMatch: false };

  const model = buildModel(analysis);
  assert.equal(model.verdict.kind, 'possible-wrong-results');
  assert.equal(model.verdict.label, 'RESULTS CHANGED');
  assert.match(renderReport(analysis), /Treat the rewrites below as unsafe|Do not ship it/);
});

test('a result-changing rewrite without a correctness finding is never optional', () => {
  const analysis = clone(healthyAnalysis);
  const rewrite: Rewrite = {
    id: 'drop-unmatched-rows',
    title: 'Use an inner join instead',
    sql: 'SELECT 1;',
    rationale: 'This removes unmatched rows.',
    equivalence: 'different-semantics',
    equivalenceNotes: 'Unmatched rows disappear.',
    priority: 3,
  };
  analysis.findings = [];
  analysis.rewrites = [rewrite];
  analysis.verification = undefined;

  const model = buildModel(analysis);
  assert.equal(model.issues[0]?.kind, 'correctness');
  assert.equal(model.issues[0]?.confidence, 'low');
  assert.equal(model.optional.length, 0);
  assert.match(renderReport(analysis), /No attached correctness finding justifies that change/);
});

test('conditional rewrites without an assumption carry a visible safety warning', () => {
  const analysis = clone(healthyAnalysis);
  analysis.findings = [];
  analysis.rewrites = [
    {
      ...analysis.rewrites[0],
      equivalence: 'conditional',
      equivalenceNotes: '',
      priority: 1,
    },
  ];
  analysis.verification = undefined;

  const report = renderReport(analysis);
  assert.match(report, /the assumption was not stated — do not ship this without checking/);
  assert.match(report, /omitted the required assumption/);
});

test('CREATE INDEX DDL recognizer accepts the PostgreSQL forms SQLSage emits', () => {
  const accepted = [
    'CREATE INDEX ix_basic ON generic.things (flag)',
    `
      CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "Ix Thing Flag"
      ON "Generic"."Things" USING btree ((lower("Display Name")), "created;at" DESC NULLS LAST)
      INCLUDE ("thing_id", "payload")
      WHERE "state" = 'open;ready'; -- a trailing comment may contain ; safely
    `,
    `CREATE INDEX ix_options ON ONLY generic.things USING btree (flag DESC NULLS LAST)
      INCLUDE (thing_id) NULLS NOT DISTINCT WITH (fillfactor = 80)
      TABLESPACE fastspace WHERE flag IS NOT NULL; /* trailing /* nested ; */ comment */`,
    `CREATE INDEX ix_storage ON generic.things (flag)
      WITH (fillfactor = 80, deduplicate_items = on);`,
    `CREATE INDEX ix_identifier_controls ON generic.things (flag)
      INCLUDE (between, "select") TABLESPACE "select";`,
    `CREATE INDEX ix_nonempty_quantifier ON generic.things (flag)
      WHERE state = ANY (ARRAY['open', 'ready']);`,
    'CREATE INDEX ix_dollar ON generic.things ((coalesce(note, $body$;$body$)));',
    'CREATE INDEX "concurrently" ON generic.things ("semi;colon" /* ; inside comment */); -- CONCURRENTLY here is prose',
  ];

  for (const ddl of accepted) {
    assert.equal(recognizeCreateIndexDdl(ddl).valid, true, ddl);
  }

  // Current q01/fan-out fixtures use multiline INCLUDE, partial WHERE, regular,
  // and CONCURRENTLY forms. Keeping every fixture recommendation in this table
  // prevents a stricter recognizer from silently deleting established paths.
  for (const { name, analysis } of FIXTURES) {
    for (const recommendation of analysis.indexes) {
      assert.equal(recognizeCreateIndexDdl(recommendation.ddl).valid, true, `${name}: ${recommendation.id}`);
    }
  }
});

test('CREATE INDEX line comments honor PostgreSQL LF, CRLF, and bare-CR boundaries', () => {
  const endings = [
    ['LF', '\n'],
    ['CRLF', '\r\n'],
    ['CR', '\r'],
  ] as const;

  for (const [label, lineEnding] of endings) {
    const prefix = `CREATE INDEX ix_${label.toLowerCase()} ON generic.things (flag);`;
    const trailingComment = `${prefix} -- trailing comment${lineEnding}`;
    const executableAfterComment = `${prefix} -- comment${lineEnding}SELECT FROM;`;

    assert.equal(recognizeCreateIndexDdl(trailingComment).valid, true, `${label}: trailing comment only`);
    assert.equal(recognizeCreateIndexDdl(executableAfterComment).valid, false, `${label}: executable payload`);

    for (const protectedDdl of [
      `CREATE INDEX ix_string_${label.toLowerCase()} ON generic.things ((coalesce(note, '-- comment${lineEnding}SELECT FROM;')));`,
      `CREATE INDEX ix_dollar_${label.toLowerCase()} ON generic.things ((coalesce(note, $payload$-- comment${lineEnding}SELECT FROM;$payload$)));`,
      `CREATE INDEX ix_block_${label.toLowerCase()} ON generic.things (flag /* -- comment${lineEnding}SELECT FROM; */);`,
    ]) {
      assert.equal(recognizeCreateIndexDdl(protectedDdl).valid, true, `${label}: protected comment-like bytes`);
    }

    const recommendation = componentIndex('ix_runtime_boundary', 'generic.things', 'flag');
    recommendation.ddl = executableAfterComment;
    const rewrite = componentRewrite('dependent-rewrite', [recommendation.id]);
    const analysis = componentAnalysis(
      [componentFinding('runtime-boundary-finding', 'generic.things', 'flag')],
      [recommendation],
      [rewrite],
    );
    const model = buildModel(analysis);
    assert.equal(model.verdict.kind, 'incomplete', label);
    assert.equal(model.counts.indexes, 0, label);
    assert.equal(model.dependencyProblems[0]?.reason, 'missing', label);

    const report = renderReport(analysis);
    assert.match(report, /Malformed analyzer input/, label);
    assert.match(report, /Required index missing/, label);
    assert.doesNotMatch(report, /coupled rewrite \+ index|Before you run it|lets reads continue|performs two table scans/, label);
    assert.equal(report.includes('SELECT FROM'), false, `${label}: executable payload rendered`);
  }
});

test('CREATE INDEX omitted-clause validators reject every saved PostgreSQL 16 grammar mismatch', () => {
  const rejected = [
    'CREATE INDEX ix_bad_with_a ON generic.things (state) WITH (fillfactor 80);',
    'CREATE INDEX ix_bad_with_b ON generic.things (state) WITH (fillfactor = 80 extra);',
    'CREATE INDEX ix_bad_with_c ON generic.things (state) WITH (fillfactor == 80);',
    'CREATE INDEX ix_bad_with_empty ON generic.things (state) WITH ();',
    'CREATE INDEX ix_bad_with_expr ON generic.things (state) WITH (fillfactor = 40 + 40);',
    'CREATE INDEX ix_bad_predicate ON generic.things (state) WHERE state = ANY ();',
    'CREATE INDEX ix_bad_all ON generic.things (state) WHERE state = ALL ();',
    'CREATE INDEX ix_bad_some_key ON generic.things (((state = SOME ())));',
    'CREATE INDEX ix_bad_include ON generic.things (state) INCLUDE (select);',
    'CREATE INDEX ix_bad_include_type_keyword ON generic.things (state) INCLUDE (authorization);',
    'CREATE INDEX ix_bad_include_empty_ident ON generic.things (state) INCLUDE ("");',
    'CREATE INDEX ix_bad_tablespace ON generic.things (state) TABLESPACE select;',
    'CREATE INDEX ix_bad_tablespace_type_keyword ON generic.things (state) TABLESPACE authorization;',
    'CREATE INDEX ix_bad_tablespace_empty_ident ON generic.things (state) TABLESPACE "";',
    String.raw`CREATE INDEX ix_bad_u_string ON generic.things ((U&'\D800'));`,
    String.raw`CREATE INDEX ix_bad_u_ident ON generic.things (U&"st\D800ate");`,
    String.raw`CREATE INDEX ix_unsupported_uescape ON generic.things (U&"st!0061te" UESCAPE '!');`,
    String.raw`CREATE INDEX ix_unsupported_escape_string ON generic.things ((E'open\x'));`,
    `CREATE INDEX ix_bad_utf16 ON generic.things ("${String.fromCharCode(0xd800)}");`,
  ];

  for (const ddl of rejected) {
    assert.equal(recognizeCreateIndexDdl(ddl).valid, false, ddl);
  }
});

test('CREATE INDEX DDL recognizer rejects other, incomplete, smuggled, and unterminated statements', () => {
  const rejected = [
    '-- TODO: write DDL',
    '/* CREATE INDEX hidden ON generic.things (flag); */',
    'DROP TABLE generic.things;',
    'SELECT 1;',
    'CREATE TABLE generic.things(flag boolean);',
    "'CREATE INDEX hidden_in_a_string ON generic.things (flag);'",
    '/* CREATE INDEX hidden ON generic.things (flag); */ DROP TABLE generic.things;',
    'CREATE INDEX',
    'CREATE INDEX ix_missing_on generic.things (flag);',
    'CREATE INDEX ix_missing_table ON (flag);',
    'CREATE INDEX ix_missing_keys ON generic.things;',
    'CREATE INDEX ix_empty_keys ON generic.things ();',
    'CREATE INDEX ix_unfinished_key ON generic.things (flag +);',
    'CREATE INDEX ix_unfinished_predicate ON generic.things (flag) WHERE flag =;',
    'CREATE INDEX ix_bad_predicate ON generic.things (flag) WHERE flag AND OR other_flag;',
    'CREATE INDEX ix_select_predicate ON generic.things (flag) WHERE SELECT;',
    'CREATE INDEX ix_smuggled ON generic.things (flag); DROP TABLE generic.things;',
    'CREATE INDEX ix_first ON generic.things (flag); CREATE INDEX ix_second ON generic.things (flag);',
    'CREATE INDEX ix_extra_semicolon ON generic.things (flag); ;',
    "CREATE INDEX ix_quote ON generic.things ((coalesce(note, 'unterminated));",
    'CREATE INDEX "ix_unterminated ON generic.things (flag);',
    'CREATE INDEX ix_dollar ON generic.things ((coalesce(note, $tag$unterminated));',
    'CREATE INDEX ix_comment ON generic.things (flag); /* unterminated',
  ];

  assert.equal(recognizeCreateIndexDdl('   \n\t').valid, false);
  for (const ddl of rejected) {
    assert.equal(recognizeCreateIndexDdl(ddl).valid, false, ddl);
  }
});

test('rejected index DDL stays visible as malformed input and blocks exact-ID dependents', () => {
  const rejected = [
    '-- TODO: write DDL',
    'DROP TABLE generic.things;',
    'CREATE INDEX ix_incomplete',
    'CREATE INDEX ix_smuggled ON generic.things (flag); DROP TABLE generic.things;',
    "CREATE INDEX ix_quote ON generic.things ((coalesce(note, 'unterminated));",
  ];

  for (const ddl of rejected) {
    const recommendation = componentIndex('ix_runtime_boundary', 'generic.things', 'flag');
    recommendation.ddl = ddl;
    const rewrite = componentRewrite('dependent-rewrite', [recommendation.id]);
    const analysis = componentAnalysis(
      [componentFinding('runtime-boundary-finding', 'generic.things', 'flag')],
      [recommendation],
      [rewrite],
    );

    const model = buildModel(analysis);
    assert.equal(model.verdict.kind, 'incomplete', ddl);
    assert.equal(model.counts.indexes, 0, ddl);
    assert.equal(model.dependencyProblems.length, 1, ddl);
    assert.equal(model.dependencyProblems[0]?.reason, 'missing', ddl);
    assert.ok(model.validationProblems.some((problem) => problem.includes('ddl (')), ddl);

    const report = renderReport(analysis);
    assert.match(report, /Malformed analyzer input/, ddl);
    assert.match(report, /Required index missing/, ddl);
    assert.doesNotMatch(report, /coupled rewrite \+ index/, ddl);
    assert.doesNotMatch(report, /Before you run it|lets reads continue|performs two table scans/, ddl);
    assert.equal(report.includes(ddl.trim()), false, `rejected payload rendered: ${ddl}`);
    assert.doesNotMatch(report, /DROP TABLE generic\.things|TODO: write DDL/, ddl);
  }
});

test('PostgreSQL-invalid index grammar cannot satisfy dependencies or reach DDL and locking advice', () => {
  const rejected = [
    'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WITH (fillfactor 80);',
    'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WITH (fillfactor = 80 extra);',
    'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WITH (fillfactor == 80);',
    'CREATE INDEX ix_runtime_boundary ON generic.things (flag) WHERE flag = ANY ();',
    'CREATE INDEX ix_runtime_boundary ON generic.things (flag) INCLUDE (select);',
    'CREATE INDEX ix_runtime_boundary ON generic.things (flag) TABLESPACE select;',
    String.raw`CREATE INDEX ix_runtime_boundary ON generic.things ((U&'\D800'));`,
    String.raw`CREATE INDEX ix_runtime_boundary ON generic.things (U&"fl\D800ag");`,
  ];

  for (const ddl of rejected) {
    const recommendation = componentIndex('ix_runtime_boundary', 'generic.things', 'flag');
    recommendation.ddl = ddl;
    const rewrite = componentRewrite('dependent-rewrite', [recommendation.id]);
    const analysis = componentAnalysis(
      [componentFinding('runtime-boundary-finding', 'generic.things', 'flag')],
      [recommendation],
      [rewrite],
    );

    const model = buildModel(analysis);
    assert.equal(model.verdict.kind, 'incomplete', ddl);
    assert.equal(model.counts.indexes, 0, ddl);
    assert.equal(model.dependencyProblems[0]?.reason, 'missing', ddl);
    const report = renderReport(analysis);
    assert.match(report, /Malformed analyzer input/, ddl);
    assert.match(report, /Required index missing/, ddl);
    assert.equal(report.includes(ddl), false, `invalid DDL rendered: ${ddl}`);
    assert.doesNotMatch(report, /coupled rewrite \+ index|Before you run it|lets reads continue|performs two table scans/, ddl);
  }
});

test('renderer revalidates index DDL after model construction', () => {
  const recommendation = componentIndex('ix_runtime_boundary', 'generic.things', 'flag');
  Object.defineProperty(recommendation, 'ddl', {
    enumerable: true,
    configurable: true,
    get() {
      return new Error().stack?.includes('fixBlocks')
        ? 'DROP TABLE generic.things;'
        : 'CREATE INDEX ix_runtime_boundary ON generic.things (flag);';
    },
  });
  const report = renderReport(componentAnalysis([], [recommendation], []));
  assert.match(report, /DDL rejected/);
  assert.doesNotMatch(report, /DROP TABLE generic\.things|Before you run it|lets reads continue|performs two table scans/);
});

test('renderer revalidates bare-CR line-comment boundaries after model construction', () => {
  const recommendation = componentIndex('ix_runtime_boundary', 'generic.things', 'flag');
  Object.defineProperty(recommendation, 'ddl', {
    enumerable: true,
    configurable: true,
    get() {
      return new Error().stack?.includes('fixBlocks')
        ? 'CREATE INDEX ix_runtime_boundary ON generic.things (flag); -- comment\rSELECT FROM;'
        : 'CREATE INDEX ix_runtime_boundary ON generic.things (flag);';
    },
  });
  const report = renderReport(componentAnalysis([], [recommendation], []));
  assert.match(report, /DDL rejected/);
  assert.doesNotMatch(report, /SELECT FROM|Before you run it|lets reads continue|performs two table scans/);
});

test('index deployment advice derives CONCURRENTLY only from recognized statement tokens', () => {
  const cases = [
    {
      ddl: 'CREATE INDEX ix_regular ON generic.things (flag);',
      expected: /lets reads continue but blocks inserts, updates, and deletes/,
      forbidden: /performs two table scans/,
    },
    {
      ddl: 'CREATE INDEX ix_comment ON generic.things (flag); -- CONCURRENTLY is only a comment',
      expected: /lets reads continue but blocks inserts, updates, and deletes/,
      forbidden: /performs two table scans/,
    },
    {
      ddl: 'CREATE INDEX "concurrently" ON generic.things (flag);',
      expected: /lets reads continue but blocks inserts, updates, and deletes/,
      forbidden: /performs two table scans/,
    },
    {
      ddl: "CREATE INDEX ix_string ON generic.things ((coalesce(note, 'concurrently')));",
      expected: /lets reads continue but blocks inserts, updates, and deletes/,
      forbidden: /performs two table scans/,
    },
    {
      ddl: 'CREATE INDEX CONCURRENTLY ix_live ON generic.things (flag);',
      expected: /performs two table scans, can wait on old transactions/,
      forbidden: /lets reads continue but blocks inserts, updates, and deletes/,
    },
  ];

  for (const entry of cases) {
    const recommendation = componentIndex('ix_locking_mode', 'generic.things', 'flag');
    recommendation.ddl = entry.ddl;
    const report = renderReport(componentAnalysis([], [recommendation], []));
    assert.match(report, entry.expected, entry.ddl);
    assert.doesNotMatch(report, entry.forbidden, entry.ddl);
  }
});

test('index deployment warnings distinguish regular and concurrent builds', () => {
  const report = renderReport(nonSargableAnalysis);
  assert.match(report, /performs two table scans, can wait on old transactions/);
  assert.match(report, /lets reads continue but blocks inserts, updates, and deletes/);
  assert.doesNotMatch(report, /blocks every reader and writer/);
});

test('structured categories make q05, q06, and q07-shaped findings lead regardless of wording', () => {
  const cases: Array<{ finding: Finding; kind: string; verdict: string }> = [
    {
      finding: finding({
        id: 'three-valued-comparison-excludes-candidates',
        title: 'Candidate membership is evaluated with an indeterminate marker',
        severity: 'critical',
        category: 'correctness',
        impact: 'A nullable subquery value causes every customer candidate to fail the requested exclusion test.',
      }),
      kind: 'correctness',
      verdict: 'wrong-results',
    },
    {
      finding: finding({
        id: 'aggregate-after-one-to-many-expansion',
        title: 'Aggregation occurs after a one-to-many join',
        severity: 'critical',
        category: 'correctness',
        impact: 'Each order total participates once per item, so reported revenue exceeds the true per-order total.',
      }),
      kind: 'correctness',
      verdict: 'wrong-results',
    },
    {
      finding: finding({
        id: 'right-filter-removes-null-extension',
        title: 'WHERE predicate eliminates NULL-extended rows',
        severity: 'high',
        category: 'intent',
        impact: 'The statement behaves as an inner join and excludes customers lacking a completed order.',
      }),
      kind: 'intent',
      verdict: 'intent-required',
    },
  ];

  for (const entry of cases) {
    const analysis = focusedAnalysis(entry.finding);
    analysis.findings.push(finding({
      id: `competing-performance-${entry.finding.id}`,
      title: 'A full scan is expensive',
      severity: 'critical',
      category: 'performance',
      evidence: { sqlFragment: 'FROM unrelated_large_relation' },
      impact: 'The scan dominates predicted runtime but does not alter result semantics.',
    }));
    const model = buildModel(analysis);
    assert.equal(model.issues[0]?.findings[0]?.id, entry.finding.id);
    assert.equal(model.issues[0]?.kind, entry.kind);
    assert.equal(model.verdict.kind, entry.verdict);
  }
});

test('performance category cannot be promoted by correctness-shaped or negated prose', () => {
  const analysis = focusedAnalysis(finding({
    id: 'duplicate-rows-sort-work',
    title: 'Duplicate rows increase sort work',
    category: 'performance',
    impact: 'The duplicate rows are intentional and the result is correct; only sort volume increases.',
  }));
  const model = buildModel(analysis);
  assert.equal(model.issues[0]?.kind, 'performance');
  assert.notEqual(model.verdict.kind, 'wrong-results');
  assert.doesNotMatch(renderReport(analysis), /WRONG RESULTS/);
});

test('missing or invalid finding category is rejected instead of inferred from prose', () => {
  const analysis = clone(healthyAnalysis) as Analysis & { findings: unknown[] };
  analysis.findings = [{
    ...finding({ title: 'This says wrong results and duplicate rows' }),
    // Deliberately invalid: the point of the test is that a missing
    // category is rejected rather than inferred.
    category: undefined as unknown as Finding['category'],
  }];
  analysis.rewrites = [];
  analysis.indexes = [];
  analysis.semantics.caveats = [];
  const model = buildModel(analysis as Analysis);
  assert.equal(model.verdict.kind, 'incomplete');
  assert.equal(model.issues.length, 0);
  assert.ok(model.validationProblems.some((problem) => problem.includes('category')));
  assert.match(renderReport(analysis as Analysis), /required fields are invalid: category/);
});

test('finding actionability, not remediation wording, controls required, optional, and no-action states', () => {
  const none = focusedAnalysis(finding({
    severity: 'medium',
    actionability: 'none',
    remediation: 'No performance change is justified.',
  }));
  const noneModel = buildModel(none);
  assert.equal(noneModel.verdict.kind, 'clean');
  assert.equal(noneModel.issues.length, 0);
  assert.equal(noneModel.cleared.length, 1);
  assert.doesNotMatch(renderReport(none), /## Do this first/);

  const actionSoundingObservation = focusedAnalysis(finding({
    severity: 'high',
    actionability: 'none',
    remediation: 'Immediately create an index and rewrite the statement.',
  }));
  assert.equal(buildModel(actionSoundingObservation).issues.length, 0);
  assert.doesNotMatch(renderReport(actionSoundingObservation), /## Do this first/);

  const optional = focusedAnalysis(finding({
    severity: 'medium',
    actionability: 'optional',
    remediation: 'Rename the alias when this file is next edited.',
  }));
  const optionalModel = buildModel(optional);
  assert.equal(optionalModel.issues.length, 0);
  assert.equal(optionalModel.optional[0]?.actionability, 'optional');
  const optionalReport = renderReport(optional);
  assert.doesNotMatch(optionalReport, /## Do this first/);
  assert.match(optionalReport, /Optional cleanup.*Rename the alias/s);
});

test('missing finding actionability is rejected rather than inferred from prose or severity', () => {
  const analysis = focusedAnalysis(finding()) as Analysis & { findings: unknown[] };
  // Deliberately invalid, as above.
  analysis.findings = [{ ...finding(), actionability: undefined as unknown as Finding['actionability'] }];
  const model = buildModel(analysis as Analysis);
  assert.equal(model.verdict.kind, 'incomplete');
  assert.equal(model.issues.length, 0);
  assert.ok(model.validationProblems.some((problem) => problem.includes('actionability')));
});

test('hard binding and validation trust gates precede categorical verdicts without hiding valid risks', () => {
  const hardBinding = focusedAnalysis(finding({ severity: 'critical', category: 'correctness' }));
  hardBinding.ir.bindingErrors = [{
    message: 'The referenced output column is ambiguous.',
    sqlFragment: 'ambiguous_total',
    severity: 'error',
  }];
  const hardModel = buildModel(hardBinding);
  assert.equal(hardModel.verdict.kind, 'incomplete');
  assert.equal(hardModel.issues[0]?.kind, 'correctness');
  const hardReport = renderReport(hardBinding);
  assert.match(hardReport, /> ## ANALYSIS INCOMPLETE/);
  assert.match(hardReport, /Provisional actions/);
  assert.match(hardReport, /A material query issue/);
  assert.doesNotMatch(hardReport, /> ## WRONG RESULTS/);

  const malformedExecution = focusedAnalysis(finding({ severity: 'critical', category: 'correctness' }));
  malformedExecution.execution.accessPaths = [{}] as never;
  const malformedModel = buildModel(malformedExecution);
  assert.equal(malformedModel.verdict.kind, 'incomplete');
  assert.equal(malformedModel.issues[0]?.kind, 'correctness');
  assert.ok(malformedModel.validationProblems.some((problem) => problem.includes('execution.accessPaths')));
});

test('blank safety-critical finding fields cannot support a categorical verdict', () => {
  const cases: Array<{ field: string; finding: Finding }> = [
    { field: 'evidence.sqlFragment', finding: finding({ evidence: { sqlFragment: ' \n\t ' } }) },
    { field: 'impact', finding: finding({ impact: '   ' }) },
    { field: 'remediation', finding: finding({ remediation: '\n\t' }) },
  ];
  for (const entry of cases) {
    const analysis = focusedAnalysis(entry.finding);
    analysis.findings[0].category = 'correctness';
    analysis.findings[0].severity = 'critical';
    const model = buildModel(analysis);
    assert.equal(model.verdict.kind, 'incomplete', entry.field);
    assert.equal(model.issues.length, 0, entry.field);
    assert.ok(model.validationProblems.some((problem) => problem.includes(entry.field)), entry.field);
    assert.doesNotMatch(renderReport(analysis), /> ## WRONG RESULTS/, entry.field);
  }
});

test('blank analysis SQL is incomplete even when fallback IR SQL can still identify the statement', () => {
  for (const blank of ['', ' \n\t ']) {
    const analysis = clone(healthyAnalysis);
    analysis.sql = blank;
    const model = buildModel(analysis);
    assert.equal(model.verdict.kind, 'incomplete');
    assert.ok(model.validationProblems.some((problem) => problem.includes('analysis.sql')));
    assert.equal(model.originalSql, analysis.ir.originalSql);
  }

  const absent = clone(healthyAnalysis);
  absent.sql = '';
  absent.ir.originalSql = '   ';
  const report = renderReport(absent);
  assert.match(report, /> ## ANALYSIS INCOMPLETE/);
  assert.match(report, /SQL unavailable/);
  assert.doesNotMatch(report, /> ## NO ACTION NEEDED/);
});

test('blank rewrite SQL is rejected and cannot render as a deployable action', () => {
  const analysis = clone(nonSargableAnalysis);
  analysis.rewrites[0].sql = ' \n\t ';
  const model = buildModel(analysis);
  assert.equal(model.verdict.kind, 'incomplete');
  assert.equal(model.counts.rewrites, 0);
  assert.ok(model.validationProblems.some((problem) => problem.includes('sql')));
  const report = renderReport(analysis);
  assert.doesNotMatch(report, /Fix — Filter the raw created_at column/);
  assert.doesNotMatch(report, /coupled rewrite \+ index/);
});

test('timing comparison distinguishes improvement, noise-range, and regression', () => {
  const faster = clone(healthyAnalysis);
  faster.verification = { baselineMs: 100, optimizedMs: 50, resultsMatch: true };
  assert.equal(buildModel(faster).timing.kind, 'improvement');
  assert.match(renderReport(faster), /50 ms faster \(50\.0%; 2\.00x speedup\)/);

  const similar = clone(healthyAnalysis);
  similar.verification = { baselineMs: 100, optimizedMs: 110, resultsMatch: true };
  assert.equal(buildModel(similar).timing.kind, 'similar');
  assert.match(renderReport(similar), /10 ms slower \(10\.0%\).*effectively unchanged/);

  const slower = clone(healthyAnalysis);
  slower.verification = { baselineMs: 100, optimizedMs: 300, resultsMatch: true };
  const slowerModel = buildModel(slower);
  assert.equal(slowerModel.timing.kind, 'regression');
  assert.equal(slowerModel.verdict.label, 'MEASURED REGRESSION');
  const slowerReport = renderReport(slower);
  assert.match(slowerReport, /200 ms slower \(200\.0%; 3\.00x regression\)/);
  assert.doesNotMatch(slowerReport, /effectively unchanged/);
});

test('zero, negative, non-finite, and missing timings never produce a ratio', () => {
  const cases: Array<{ baselineMs?: number; optimizedMs?: number }> = [
    { baselineMs: 100, optimizedMs: 0 },
    { baselineMs: 0, optimizedMs: 100 },
    { baselineMs: -10, optimizedMs: 5 },
    { baselineMs: Number.NaN, optimizedMs: 5 },
    { baselineMs: 100, optimizedMs: Number.POSITIVE_INFINITY },
    { baselineMs: 100 },
    { optimizedMs: 50 },
    {},
  ];
  for (const verification of cases) {
    const analysis = clone(healthyAnalysis);
    analysis.verification = verification;
    const model = buildModel(analysis);
    const report = renderReport(analysis);
    assert.equal(model.timing.kind, 'unavailable');
    assert.match(report, /paired comparison is unavailable/i);
    assert.doesNotMatch(report, /\d+(?:\.\d+)?x (?:speedup|regression)/);
    assert.doesNotMatch(report, /1000000/);
    assert.doesNotMatch(report, /\bNaN\b|Infinity/);
  }
});

test('partial verification states name every measured and unchecked dimension', () => {
  const baselineOnly = clone(healthyAnalysis);
  baselineOnly.verification = { baselineMs: 100 };
  const baselineReport = renderReport(baselineOnly);
  assert.match(baselineReport, /Baseline timing: measured at 100 ms/);
  assert.match(baselineReport, /Optimized timing: not measured\/supplied/);
  assert.match(baselineReport, /Result check: not supplied\/not checked/);
  assert.match(baselineReport, /Plan capture: baseline not captured; optimized not captured/);

  const planOnly = clone(healthyAnalysis);
  planOnly.verification = { baselinePlan: { node: 'Seq Scan' } };
  const planReport = renderReport(planOnly);
  assert.match(planReport, /Plan capture: baseline captured; optimized not captured/);
  assert.match(planReport, /Plan delta unavailable/);

  const pairedPlans = clone(healthyAnalysis);
  pairedPlans.verification = { baselinePlan: {}, optimizedPlan: {} };
  assert.match(renderReport(pairedPlans), /no structured comparison was associated/);
});

test('absent verification is unverified, not evidence that a database was unavailable', () => {
  const analysis = clone(healthyAnalysis);
  analysis.verification = undefined;
  const report = renderReport(analysis);
  assert.match(report, /Live verification was not supplied\/run/);
  assert.doesNotMatch(report, /No live database was available/);
});

test('predicted execution fields are labeled predicted even when plan payloads exist', () => {
  const report = renderReport(fanOutAnalysis);
  assert.match(report, /Predicted execution and scaling/);
  assert.match(report, /Predicted runtime share/);
  assert.match(report, /analyzer predictions unless a finding explicitly cites observed plan evidence/);
  assert.doesNotMatch(report, /## Where the time goes/);
});

test('structured saved-plan facts are labeled observed while future scaling stays predicted', () => {
  const analysis = clone(healthyAnalysis);
  analysis.execution.accessPaths[0]!.reason = 'Observed in the saved plan-only EXPLAIN: PostgreSQL used seq scan.';
  analysis.execution.dominantCosts[0]!.what = 'Observed Seq Scan on orders';
  analysis.verification = { baselinePlan: { Plan: { 'Node Type': 'Seq Scan' } } };

  const report = renderReport(analysis);
  assert.match(report, /Observed plan and predicted scaling/);
  assert.match(report, /Observed plan shape/);
  assert.match(report, /Observed (?:cost driver|\d+% share)/);
  assert.match(report, /Access paths and cost drivers come from the captured baseline plan/);
  assert.match(report, /Scaling at other data volumes.*remain predicted and unverified/);
});

test('index dependencies resolve only by exact stable id and missing ids block the lede', () => {
  const exact = buildModel(nonSargableAnalysis);
  assert.equal(exact.dependencyProblems.length, 0);

  for (const required of ['idx_orders_status', 'idx_does_not_exist']) {
    const analysis = clone(nonSargableAnalysis);
    analysis.rewrites[0].requiresIndexes = [required];
    const model = buildModel(analysis);
    assert.equal(model.dependencyProblems[0]?.requiredIndexId, required);
    assert.equal(model.dependencyProblems[0]?.reason, 'missing');
    const report = renderReport(analysis);
    assert.match(report, /Action blocked/);
    assert.match(report, /Required index missing/);
    assert.match(report, /do not assume a similarly named index or DDL substring/i);
    assert.doesNotMatch(report, /coupled rewrite \+ index/);
  }
});

test('duplicate index ids are ambiguous dependencies rather than arbitrary matches', () => {
  const analysis = clone(nonSargableAnalysis);
  analysis.indexes.push({
    ...clone(analysis.indexes[0]),
    ddl: 'CREATE INDEX idx_duplicate_contract_id ON shop.orders (status, created_at);',
  });
  const model = buildModel(analysis);
  assert.equal(model.dependencyProblems[0]?.reason, 'ambiguous');
  assert.ok(model.validationProblems.some((problem) => problem.includes('duplicated')));
  const report = renderReport(analysis);
  assert.match(report, /Required index ID ambiguous/);
  assert.match(report, /BLOCKED/);
});

test('malformed findings, recommendations, semantics, and execution entries degrade visibly', () => {
  const analysis = clone(healthyAnalysis) as Analysis & Record<string, unknown>;
  analysis.findings = [{}] as never;
  analysis.indexes = [{}] as never;
  analysis.rewrites = [{}] as never;
  analysis.semantics = { ...analysis.semantics, steps: [{}] } as never;
  analysis.execution = {
    ...analysis.execution,
    accessPaths: [{}],
    dominantCosts: [{ what: 'sort', why: 'large', estimatedShare: Number.NaN }, {}],
  } as never;
  analysis.verification = undefined;

  const model = buildModel(analysis);
  assert.equal(model.verdict.kind, 'incomplete');
  assert.ok(model.validationProblems.length >= 6);
  const report = renderReport(analysis);
  assert.match(report, /Malformed analyzer input/);
  assert.match(report, /was ignored because required fields are invalid/);
  assert.doesNotMatch(report, PLACEHOLDER);
});

test('C0, C1, and ANSI input controls are escaped in markdown and terminal plain mode', () => {
  const analysis = clone(healthyAnalysis);
  analysis.semantics.headline = 'headline\u001b[31mred\u0007bell\u0085next';
  analysis.catalogName = 'catalog\u009b31m';
  analysis.sql = 'SELECT 1; -- \u001b[2J\u0000\n\tSELECT 2;';
  analysis.findings[0].title += '\u0008\u001b[1m';

  const markdown = renderReport(analysis, { format: 'markdown' });
  const plain = renderReport(analysis, { format: 'terminal', color: false });
  const colored = renderReport(analysis, { format: 'terminal', color: true });
  const unsafe = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
  assert.doesNotMatch(markdown, unsafe);
  assert.doesNotMatch(plain, unsafe);
  assert.equal(colored.replace(ANSI, ''), plain);
  assert.match(markdown, /\\x1B\[31mred\\x07bell\\x85next/);
  assert.match(markdown, /\\x1B\[2J\\x00/);
});

test('the executive summary carries result grain and the report renders original SQL once', () => {
  const report = renderReport(fanOutAnalysis);
  assert.match(report, /\*\*Result grain\.\*\* One row per customer/);
  assert.equal(report.match(/## Original SQL/g)?.length, 1);
  const originalSection = report.split('## Original SQL')[1]?.split('---')[0] ?? '';
  assert.match(originalSection, /SELECT c\.customer_id,/);
  assert.match(originalSection, /JOIN shop\.order_items oi/);
  assert.ok(report.indexOf('**Result grain.**') < report.indexOf('## Do this first'));
  assert.ok(report.indexOf('## Do this first') < report.indexOf('## Original SQL'));
  assert.ok(report.indexOf('## Original SQL') < report.indexOf('## 1.'));
});

test('relationship labels distinguish dependency, alternative, and supplement', () => {
  const coupled = renderReport(nonSargableAnalysis);
  assert.match(coupled, /\+1 alternative in §1/);
  assert.match(coupled, /Index \(required dependency\)/);
  assert.match(coupled, /Index \(alternative\)/);

  const fanOut = renderReport(fanOutAnalysis);
  assert.match(fanOut, /\+2 supplements in §1/);
  assert.match(fanOut, /Index \(supplement\)/);
  assert.doesNotMatch(fanOut.split('---')[0], /\+2 alternatives/);
});

test('rendering and model construction do not mutate caller input', () => {
  for (const analysis of [fanOutAnalysis, nonSargableAnalysis, healthyAnalysis]) {
    const before = clone(analysis);
    buildModel(analysis);
    renderReport(analysis, { format: 'terminal', color: true });
    assert.deepEqual(analysis, before);
  }
});
