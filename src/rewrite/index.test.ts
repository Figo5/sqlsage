import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CORPUS } from '../../corpus/queries.ts';
import { detectAntiPatterns } from '../antipatterns/index.ts';
import { recommendIndexes } from '../indexes/index.ts';
import { bindQuery } from '../ir/index.ts';
import type { Catalog, Finding, IndexRecommendation, Rewrite } from '../types.ts';
import { proposeRewrites } from './index.ts';

const catalog = JSON.parse(
  await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8'),
) as Catalog;

interface Advice {
  findings: Finding[];
  indexes: IndexRecommendation[];
  rewrites: Rewrite[];
}

function advice(sql: string, sourceCatalog: Catalog = catalog): Advice {
  const ir = bindQuery(sql, sourceCatalog);
  const findings = detectAntiPatterns(ir, sourceCatalog);
  return {
    findings,
    indexes: recommendIndexes(ir, sourceCatalog, findings),
    rewrites: proposeRewrites(ir, sourceCatalog, findings),
  };
}

function corpusAdvice(shortId: string): Advice {
  const query = CORPUS.find((candidate) => candidate.id.startsWith(shortId));
  assert.ok(query);
  return advice(query.sql);
}

test('supported corpus rewrites bind cleanly and unsupported decisions stay empty', () => {
  const expected: Record<string, number> = {
    q01: 1, q02: 0, q03: 1, q04: 1, q05: 1, q06: 1,
    q07: 0, q08: 1, q09: 1, q10: 0, q11: 1, q12: 0,
  };
  for (const query of CORPUS) {
    const result = corpusAdvice(query.id.slice(0, 3));
    assert.equal(result.rewrites.length, expected[query.id.slice(0, 3)], query.id);
    for (const rewrite of result.rewrites) {
      assert.deepEqual(bindQuery(rewrite.sql, catalog).bindingErrors, [], `${query.id}: ${rewrite.sql}`);
      assert.match(rewrite.sql, /^(?:WITH|SELECT)\b/i);
      assert.ok(rewrite.rationale.trim());
      assert.ok(rewrite.equivalenceNotes.trim());
    }
  }
});

test('q01 uses an exclusive next-month boundary and requires the exact emitted M5 id', () => {
  const result = corpusAdvice('q01');
  const [rewrite] = result.rewrites;
  assert.equal(rewrite?.equivalence, 'exact');
  assert.match(rewrite!.sql, />=\s*TIMESTAMPTZ '2024-03-01'/i);
  assert.match(rewrite!.sql, /<\s*TIMESTAMPTZ '2024-04-01'/i);
  assert.doesNotMatch(rewrite!.sql, /date_trunc|BETWEEN/i);
  assert.deepEqual(rewrite!.requiresIndexes, [result.indexes[0]!.id]);
  assert.match(result.indexes[0]!.expectedEffect, /coupled/i);
});

test('repeated aggregates collapse only when source, key, and filters agree', () => {
  const [rewrite] = corpusAdvice('q03').rewrites;
  assert.equal(rewrite?.equivalence, 'exact');
  assert.match(rewrite!.sql, /LEFT JOIN LATERAL/i);
  assert.equal((rewrite!.sql.match(/FROM "shop"\."orders"/g) ?? []).length, 1);
  assert.match(rewrite!.sql, /count\(\*\).*max\(/is);
  assert.doesNotMatch(rewrite!.sql, /GROUP BY.*customer_id/is);

  const incompatible = advice(`SELECT c.customer_id,
      (SELECT count(*) FROM shop.orders o WHERE o.customer_id = c.customer_id AND o.status = 'complete') AS complete_count,
      (SELECT max(o2.created_at) FROM shop.orders o2 WHERE o2.customer_id = c.customer_id AND o2.status = 'pending') AS pending_max
    FROM shop.customers c WHERE c.loyalty_tier = 'gold'`);
  assert.ok(incompatible.findings.some((finding) => finding.id === 'repeated-correlated-aggregate-scans'));
  assert.deepEqual(incompatible.rewrites, [], 'different inner filters cannot share one LATERAL WHERE clause');
});

test('keyset rewrite uses one row-value comparison and exposes the cursor contract', () => {
  const result = corpusAdvice('q04');
  const [rewrite] = result.rewrites;
  assert.equal(rewrite?.equivalence, 'conditional');
  assert.match(rewrite!.sql, /\("o"\."created_at", "o"\."order_id"\) < \(\$1, \$2\)/);
  assert.doesNotMatch(rewrite!.sql, /OFFSET/i);
  assert.match(rewrite!.equivalenceNotes, /cannot jump directly/i);
  assert.deepEqual(rewrite!.requiresIndexes, [result.indexes[0]!.id]);

  const nonUnique = advice(`SELECT o.order_id FROM shop.orders o
    ORDER BY o.created_at DESC LIMIT 20 OFFSET 10000`);
  assert.ok(nonUnique.findings.some((finding) => finding.id === 'deep-offset-pagination'));
  assert.deepEqual(nonUnique.rewrites, [], 'one non-unique order column is not enough for a safe cursor');
});

test('nullable NOT IN and fan-out repairs are labeled different-semantics', () => {
  const q05 = corpusAdvice('q05');
  const [anti] = q05.rewrites;
  assert.equal(anti?.equivalence, 'different-semantics');
  assert.match(anti!.sql, /NOT EXISTS/i);
  assert.doesNotMatch(anti!.sql, /NOT IN/i);
  assert.match(anti!.equivalenceNotes, /intentionally repairs/i);
  assert.deepEqual(anti!.requiresIndexes, [q05.indexes[0]!.id]);

  const [fanout] = corpusAdvice('q06').rewrites;
  assert.equal(fanout?.equivalence, 'different-semantics');
  assert.match(fanout!.sql, /GROUP BY "oi_src"\."order_id"/i);
  assert.match(fanout!.sql, /sum\("oi"\."sqlsage_row_count"\)::bigint/i);
  assert.match(fanout!.equivalenceNotes, /preserves.*COUNT\(\*\)/i);
  assert.equal(fanout!.requiresIndexes, undefined);
});

test('outer-join intent and pushed-down HAVING are never silently rewritten', () => {
  assert.deepEqual(corpusAdvice('q07').rewrites, []);
  assert.deepEqual(corpusAdvice('q10').rewrites, []);
  assert.deepEqual(corpusAdvice('q12').rewrites, []);
});

test('DISTINCT-to-EXISTS requires a projected unique driver key', () => {
  const result = corpusAdvice('q08');
  const [rewrite] = result.rewrites;
  assert.equal(rewrite?.equivalence, 'exact');
  assert.match(rewrite!.sql, /WHERE EXISTS \(SELECT 1/i);
  assert.doesNotMatch(rewrite!.sql, /SELECT DISTINCT/i);
  assert.ok(rewrite!.requiresIndexes?.every((id) => result.indexes.some((index) => index.id === id)));

  const noKey = advice(`SELECT DISTINCT c.email
    FROM shop.customers c
    JOIN shop.orders o ON o.customer_id = c.customer_id
    JOIN shop.order_items oi ON oi.order_id = o.order_id`);
  assert.ok(noKey.findings.some((finding) => finding.id === 'distinct-collapses-existence-fanout'));
  assert.deepEqual(noKey.rewrites, [], 'DISTINCT could collapse separate customers sharing an email without a projected key proof');
});

test('date-cast rewrite preserves the final day with an exclusive next-day boundary', () => {
  const result = corpusAdvice('q09');
  const [rewrite] = result.rewrites;
  assert.equal(rewrite?.equivalence, 'exact');
  assert.match(rewrite!.sql, />=\s*TIMESTAMPTZ '2024-06-01'/i);
  assert.match(rewrite!.sql, /<\s*TIMESTAMPTZ '2024-07-01'/i);
  assert.doesNotMatch(rewrite!.sql, /BETWEEN/i);
  assert.deepEqual(rewrite!.requiresIndexes, [result.indexes[0]!.id]);
});

test('top-per-group rewrite preserves ties instead of choosing one row', () => {
  const result = corpusAdvice('q11');
  const [rewrite] = result.rewrites;
  assert.equal(rewrite?.equivalence, 'exact');
  assert.match(rewrite!.sql, /^WITH "sqlsage_extreme"/i);
  assert.match(rewrite!.sql, /max\(o2\.created_at\)/i);
  assert.match(rewrite!.sql, /"extreme_value" = "o"\."created_at"/i);
  assert.doesNotMatch(rewrite!.sql, /DISTINCT ON|row_number/i);
  assert.match(rewrite!.equivalenceNotes, /preserves every row tied/i);
  assert.deepEqual(rewrite!.requiresIndexes, [result.indexes[0]!.id]);
});

test('no finding evidence means no rewrite even for recognizable SQL text', () => {
  const query = CORPUS.find((candidate) => candidate.id.startsWith('q01'))!;
  const ir = bindQuery(query.sql, catalog);
  assert.deepEqual(proposeRewrites(ir, catalog, []), []);
});

test('col = NULL rewrites to IS NULL and col <> NULL rewrites to IS NOT NULL, both result-changing', () => {
  const eqResult = advice(`SELECT customer_id FROM shop.customers WHERE email = NULL`);
  const [eqRewrite] = eqResult.rewrites;
  assert.equal(eqRewrite?.id, 'rewrite-null-literal-to-is-null');
  assert.equal(eqRewrite?.equivalence, 'different-semantics');
  assert.match(eqRewrite!.sql, /"customers"\."email" IS NULL/i);
  assert.deepEqual(bindQuery(eqRewrite!.sql, catalog).bindingErrors, []);

  const neResult = advice(`SELECT order_id FROM shop.orders WHERE coupon_code <> NULL`);
  const [neRewrite] = neResult.rewrites;
  assert.equal(neRewrite?.id, 'rewrite-null-literal-to-is-null');
  assert.equal(neRewrite?.equivalence, 'different-semantics');
  assert.match(neRewrite!.sql, /"orders"\."coupon_code" IS NOT NULL/i);
  assert.deepEqual(bindQuery(neRewrite!.sql, catalog).bindingErrors, []);
  assert.match(neRewrite!.equivalenceNotes, /returns rows/i);
});

test('UNION with disjoint arms rewrites to UNION ALL as an exact, clean-binding change', () => {
  const { rewrites } = advice(`SELECT customer_id FROM shop.orders WHERE status = 'complete'
    UNION
    SELECT customer_id FROM shop.orders WHERE status = 'cancelled'`);
  const [rewrite] = rewrites;
  assert.equal(rewrite?.id, 'rewrite-union-to-union-all');
  assert.equal(rewrite?.equivalence, 'exact');
  assert.match(rewrite!.sql, /UNION ALL/i);
  assert.doesNotMatch(rewrite!.sql, /\bUNION\s+UNION ALL\b/i);
  assert.deepEqual(bindQuery(rewrite!.sql, catalog).bindingErrors, []);
  assert.match(rewrite!.equivalenceNotes, /disjoint/i);

  // Overlapping arms produce the intent-only finding but no rewrite.
  const overlapping = advice(`SELECT customer_id FROM shop.orders WHERE status = 'complete'
    UNION
    SELECT customer_id FROM shop.orders WHERE customer_id > 100`);
  assert.ok(overlapping.findings.some((f) => f.id === 'union-all-eligible' && f.severity === 'info'));
  assert.deepEqual(overlapping.rewrites, [], 'intent-only tier must not auto-rewrite');
});
