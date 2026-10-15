import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizePlanEvidence } from '../plan-evidence.ts';
import { comparePlans, renderComparison } from './index.ts';

function capture(opts: {
  nodeType?: string; index?: string; ms?: number; analyzed?: boolean;
  planRows?: number; actualRows?: number; sql?: string;
}) {
  const plan: Record<string, unknown> = {
    'Node Type': opts.nodeType ?? 'Seq Scan',
    'Relation Name': 'orders',
    'Plan Rows': opts.planRows ?? 100,
    'Total Cost': 10,
  };
  if (opts.index) plan['Index Name'] = opts.index;
  if (opts.analyzed !== false) {
    plan['Actual Rows'] = opts.actualRows ?? 100;
    plan['Actual Loops'] = 1;
    plan['Actual Total Time'] = opts.ms ?? 100;
  }
  const document: Record<string, unknown> = { Plan: plan };
  if (opts.analyzed !== false) document['Execution Time'] = opts.ms ?? 100;
  return normalizePlanEvidence(opts.sql ? { planJson: [document], sql: opts.sql } : [document]);
}

test('a faster after capture is reported, but never as a benchmark', () => {
  const comparison = comparePlans(capture({ ms: 400 }), capture({ ms: 40 }));
  assert.equal(comparison.verdict.kind, 'faster');
  assert.match(comparison.verdict.headline, /10\.00x faster/);
  // One run each is not a benchmark, and saying so beside the number is the
  // difference between evidence and a claim.
  assert.ok(comparison.verdict.caveats.some((c) => /single capture/.test(c)));
});

test('a plan-only capture yields no timing verdict, because nothing ran', () => {
  const comparison = comparePlans(capture({ analyzed: false }), capture({ ms: 40, nodeType: 'Index Scan' }));
  assert.equal(comparison.timing.comparable, false);
  assert.match(comparison.timing.why!, /plan-only/);
  assert.equal(comparison.verdict.kind, 'shape-changed-only');
  assert.doesNotMatch(comparison.verdict.headline, /faster|slower/);
});

test('a zero runtime cannot establish a speed comparison', () => {
  const comparison = comparePlans(capture({ ms: 0, sql: 'SELECT 1' }), capture({ ms: 40, sql: 'select 1' }));
  assert.equal(comparison.sameQuery, 'same');
  assert.equal(comparison.timing.comparable, false);
  assert.equal(comparison.verdict.kind, 'not-comparable');
  assert.doesNotMatch(renderComparison(comparison, 'text'), /faster|slower|\bNaN\b|\bInfinity\b/);
});

test('a difference two single runs cannot separate from noise is not called an improvement', () => {
  const comparison = comparePlans(capture({ ms: 100 }), capture({ ms: 92 }));
  assert.equal(comparison.verdict.kind, 'no-measurable-change');
  assert.match(comparison.verdict.headline, /cannot separate from noise/);
});

test('comparing two different statements is flagged as such', () => {
  const comparison = comparePlans(
    capture({ ms: 400, sql: 'SELECT a FROM t' }),
    capture({ ms: 40, sql: 'SELECT b FROM u' }),
  );
  assert.equal(comparison.sameQuery, 'different');
  assert.ok(comparison.verdict.caveats.some((c) => /different statements/.test(c)));

  const same = comparePlans(capture({ ms: 400, sql: 'SELECT a FROM t;' }), capture({ ms: 40, sql: 'select  a from t' }));
  assert.equal(same.sameQuery, 'same');
  // Captures that do not state their SQL must not be claimed to match.
  assert.equal(comparePlans(capture({ ms: 1 }), capture({ ms: 1 })).sameQuery, 'unknown');
});

test('query identity preserves literal values and quoted identifiers', () => {
  const differentStatements = [
    ["SELECT 'Admin'", "SELECT 'admin'"],
    ["SELECT 'a  b'", "SELECT 'a b'"],
    ["SELECT 'a\nb'", "SELECT 'a b'"],
    ["SELECT 'It''s Admin'", "SELECT 'It''s admin'"],
    ["SELECT E'Admin\\n'", "SELECT E'admin\\n'"],
    ['SELECT $$Admin$$', 'SELECT $$admin$$'],
    ['SELECT $Tag$a  b$Tag$', 'SELECT $Tag$a b$Tag$'],
    ['SELECT "Admin" FROM users', 'SELECT "admin" FROM users'],
    ['SELECT "a  b" FROM users', 'SELECT "a b" FROM users'],
    ['SELECT "a""Admin" FROM users', 'SELECT "a""admin" FROM users'],
    ['SELECT 9007199254740993', 'SELECT 9007199254740992'],
    ["SELECT U&'abc'", "SELECT U & 'abc'"],
    ['SELECT 1 >= 2', 'SELECT 1 > 2'],
    ['SELECT 1 >> 2', 'SELECT 1 > > 2'],
    ['SELECT A\u00a0B', 'SELECT A B'],
    ["SELECT 'quoted;'", "SELECT 'quoted'"],
    ['SELECT 1; SELECT 2', 'SELECT 1; SELECT 3'],
    ['SELECT 1; SELECT 2', 'SELECT 1'],
  ];
  for (const [before, after] of differentStatements) {
    const comparison = comparePlans(capture({ sql: before }), capture({ sql: after }));
    assert.equal(comparison.sameQuery, 'different', `${before} vs ${after}`);
    assert.ok(comparison.verdict.caveats.some((c) => /different statements/.test(c)));
  }
});

test('query identity ignores keyword case and ordinary formatting outside protected text', () => {
  const sameStatements = [
    ['  SELECT A\nFROM T;  ', 'select  a from t'],
    ["SELECT 'Admin' AS ROLE;", "select  'Admin' as role"],
    ['SELECT "Admin" FROM USERS;', 'select "Admin" from users'],
    ['SELECT $$a  B$$ AS VALUE;', 'select $$a  B$$ as value'],
    ["SELECT E'it\\'s Admin' AS VALUE;", "select E'it\\'s Admin' as value"],
    ["SELECT E'it\\'s Admin';", "select e'it\\'s Admin'"],
    ["SELECT '-- /* Admin */';", "select '-- /* Admin */'"],
    ['SELECT foo$Tag$ FROM T;', 'select foo$tag$ from t'],
    ['SELECT $a$/*not a comment*/ $b$X$b$$a$;', 'select $a$/*not a comment*/ $b$X$b$$a$'],
    ['SELECT "a;";', 'select "a;"'],
    ['SELECT 1; SELECT 2;', 'select 1; select 2'],
  ];
  for (const [before, after] of sameStatements) {
    assert.equal(comparePlans(capture({ sql: before }), capture({ sql: after })).sameQuery, 'same', `${before} vs ${after}`);
  }
});

test('query identity preserves comments and their token boundaries', () => {
  const differentStatements = [
    ['SELECT 1 -- comment\n+ 2', 'SELECT 1 -- comment + 2'],
    ['SELECT /*+ SeqScan(t) */ * FROM t', 'SELECT /*+ IndexScan(t) */ * FROM t'],
    ['SELECT /* outer /* inner */ Admin */ 1', 'SELECT /* outer /* inner */ admin */ 1'],
    ['SELECT 1 - - 2', 'SELECT 1 -- 2'],
    ['SELECT 1 -- X;', 'SELECT 1 -- X'],
  ];
  for (const [before, after] of differentStatements) {
    assert.equal(comparePlans(capture({ sql: before }), capture({ sql: after })).sameQuery, 'different', `${before} vs ${after}`);
  }
  assert.equal(comparePlans(
    capture({ sql: 'SELECT /* unchanged */ A FROM T;' }),
    capture({ sql: 'select /* unchanged */ a from t' }),
  ).sameQuery, 'same');
});

test('query identity stays unknown for ambiguous or unterminated quoting', () => {
  const uncertainStatements = [
    ["SELECT 'Admin", "select 'Admin"],
    ['SELECT "Admin', 'select "Admin'],
    ['SELECT $tag$Admin', 'select $tag$Admin'],
    ['SELECT /* unfinished', 'select /* unfinished'],
    ["SELECT 'a\\b'", "select 'a\\b'"],
    ["SELECT E'a\\", "select E'a\\"],
    ["SELECT 'a'\n'b'", "select 'a' 'b'"],
    ["SELECT 'a' /* comment */\n'b'", "select 'a' /* comment */ 'b'"],
  ];
  for (const [before, after] of uncertainStatements) {
    assert.equal(comparePlans(capture({ sql: before }), capture({ sql: after })).sameQuery, 'unknown', `${before} vs ${after}`);
  }
});

test('unknown query identity is rendered without claiming SQL is absent', () => {
  const comparison = comparePlans(
    capture({ sql: "SELECT 'a\\b'" }),
    capture({ sql: "SELECT 'a\\b'" }),
  );
  assert.equal(comparison.sameQuery, 'unknown');
  assert.match(renderComparison(comparison, 'text'), /cannot confirm whether these captures describe the same query/);
  assert.doesNotMatch(renderComparison(comparison, 'markdown'), /identical in both captures|not stated/);
  assert.equal(comparePlans(capture({}), capture({ sql: 'SELECT 1' })).sameQuery, 'unknown');
  assert.equal(comparePlans(capture({ sql: 'SELECT 1' }), capture({})).sameQuery, 'unknown');
});

test('vertical tabs outside protected text leave version-sensitive identity unknown', () => {
  const uncertainStatements = [
    ["SELECT 'a'\v\n'b'", "SELECT 'a'\v 'b'"],
    ['SELECT\v1', 'SELECT\v1'],
    ['\vSELECT 1', 'SELECT 1'],
    ['SELECT 1\v', 'SELECT 1'],
  ];
  for (const [before, after] of uncertainStatements) {
    assert.equal(comparePlans(capture({ sql: before }), capture({ sql: after })).sameQuery, 'unknown', `${before} vs ${after}`);
  }
  assert.equal(comparePlans(
    capture({ sql: "SELECT 'a\vb'" }),
    capture({ sql: "SELECT 'a b'" }),
  ).sameQuery, 'different');
  assert.equal(comparePlans(
    capture({ sql: "SELECT 'a\vb' /* preserved\v */;" }),
    capture({ sql: "select 'a\vb' /* preserved\v */" }),
  ).sameQuery, 'same');
  assert.equal(comparePlans(
    capture({ sql: 'SELECT 1 -- preserved\v' }),
    capture({ sql: 'select 1 -- preserved\v' }),
  ).sameQuery, 'same');
  assert.equal(comparePlans(
    capture({ sql: 'SELECT "a\vb", $tag$a\vb$tag$;' }),
    capture({ sql: 'select "a\vb", $tag$a\vb$tag$' }),
  ).sameQuery, 'same');
});

test('structural changes are reported per relation and per index', () => {
  const comparison = comparePlans(
    capture({ ms: 400, nodeType: 'Seq Scan' }),
    capture({ ms: 40, nodeType: 'Index Only Scan', index: 'idx_orders_status_created_at' }),
  );
  const orders = comparison.accessPaths.find((entry) => entry.relation === 'orders')!;
  assert.equal(orders.changed, true);
  assert.match(orders.before!, /Seq Scan/);
  assert.match(orders.after!, /Index Only Scan/);
  assert.deepEqual(comparison.indexes.gained, ['idx_orders_status_created_at']);

  const rendered = renderComparison(comparison, 'markdown');
  assert.match(rendered, /# SQLSage plan comparison/);
  assert.match(rendered, /now used: idx_orders_status_created_at/);
  assert.doesNotMatch(rendered, /\bundefined\b|\bNaN\b/);
});
