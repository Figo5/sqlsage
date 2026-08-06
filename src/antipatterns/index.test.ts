import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { CORPUS } from '../../corpus/queries.ts';
import { bindQuery } from '../ir/index.ts';
import type { Catalog, Finding, IndexDef } from '../types.ts';
import { detectAntiPatterns } from './index.ts';

const catalog = JSON.parse(
  await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8'),
) as Catalog;

function findings(sql: string, sourceCatalog: Catalog = catalog): Finding[] {
  return detectAntiPatterns(bindQuery(sql, sourceCatalog), sourceCatalog);
}

function ids(sql: string, sourceCatalog: Catalog = catalog): string[] {
  return findings(sql, sourceCatalog).map((finding) => finding.id);
}

function corpusFindings(shortId: string): Finding[] {
  const query = CORPUS.find((candidate) => candidate.id.startsWith(shortId));
  assert.ok(query, `missing corpus query ${shortId}`);
  return findings(query.sql);
}

test('all justified corpus families are assessed and the HAVING pushdown trap stays clean', () => {
  const expected = new Map<string, string[]>([
    ['q01', ['non-sargable-function-on-column']],
    ['q02', ['limit-without-total-order', 'leading-wildcard-like', 'mixed-access-paths-under-or']],
    ['q03', ['repeated-correlated-aggregate-scans']],
    ['q04', ['deep-offset-pagination']],
    ['q05', ['not-in-nullable-subquery']],
    ['q06', ['aggregate-over-one-to-many-fanout', 'limit-without-total-order']],
    ['q07', ['left-join-null-rejected-in-where']],
    ['q08', ['distinct-collapses-existence-fanout']],
    ['q09', ['non-sargable-cast-on-column']],
    ['q10', []],
    ['q11', ['full-cardinality-correlated-aggregate']],
    ['q12', ['unindexed-json-scalar-extraction', 'large-input-distinct-aggregate', 'redundant-group-by']],
  ]);

  for (const query of CORPUS) {
    const actual = corpusFindings(query.id.slice(0, 3)).map((finding) => finding.id);
    assert.deepEqual(actual, expected.get(query.id.slice(0, 3)), query.id);
  }
});

test('every finding carries deterministic structured evidence without duplicate ids', () => {
  for (const query of CORPUS) {
    const first = corpusFindings(query.id.slice(0, 3));
    const second = corpusFindings(query.id.slice(0, 3));
    assert.deepEqual(first, second, `${query.id}: deterministic`);
    assert.equal(new Set(first.map((finding) => finding.id)).size, first.length, `${query.id}: unique ids`);
    for (const finding of first) {
      assert.match(finding.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(finding.title.trim());
      assert.ok(finding.evidence.sqlFragment.trim());
      assert.ok(finding.impact.trim());
      assert.ok(finding.remediation.trim());
      assert.ok(['correctness', 'intent', 'performance'].includes(finding.category));
      assert.ok(['required', 'optional', 'none'].includes(finding.actionability));
      assert.ok(['high', 'medium', 'low'].includes(finding.confidence));
    }
  }
});

test('nullable NOT IN is a critical correctness gate, but NOT EXISTS and proven non-null output are safe', () => {
  const [gate] = corpusFindings('q05');
  assert.equal(gate?.id, 'not-in-nullable-subquery');
  assert.deepEqual(
    [gate?.severity, gate?.category, gate?.actionability, gate?.confidence],
    ['critical', 'correctness', 'required', 'high'],
  );
  assert.equal(gate?.evidence.relation, 'events');
  assert.equal(gate?.evidence.column, 'customer_id');
  assert.match(gate!.evidence.sqlFragment, /NOT\s+IN/i);
  assert.match(gate!.impact, /nullable|NULL/i);
  assert.match(gate!.impact, /14\.5%/);
  assert.match(gate!.caveat!, /proven non-NULL/);

  assert.doesNotMatch(
    ids(`SELECT c.customer_id FROM shop.customers c
         WHERE NOT EXISTS (
           SELECT 1 FROM shop.events e WHERE e.customer_id = c.customer_id
         )`).join(','),
    /not-in-nullable/,
  );
  assert.doesNotMatch(
    ids(`SELECT c.customer_id FROM shop.customers c
         WHERE c.customer_id NOT IN (
           SELECT o.customer_id FROM shop.orders o
         )`).join(','),
    /not-in-nullable/,
  );
});

test('fan-out finding requires a duplicate-sensitive aggregate over a multiplied alias', () => {
  const [gate] = corpusFindings('q06');
  assert.equal(gate?.id, 'aggregate-over-one-to-many-fanout');
  assert.deepEqual(
    [gate?.severity, gate?.category, gate?.actionability],
    ['critical', 'correctness', 'required'],
  );
  assert.equal(gate?.evidence.relation, 'order_items');
  assert.equal(gate?.evidence.column, 'order_id');
  assert.match(gate!.evidence.sqlFragment, /sum\(o\.total_cents\)/i);
  assert.match(gate!.evidence.sqlFragment, /(?:oi\.order_id\s*=\s*o\.order_id|o\.order_id\s*=\s*oi\.order_id)/i);

  const reversed = ids(`SELECT sum(o.total_cents)
    FROM shop.order_items oi
    JOIN shop.orders o ON o.order_id = oi.order_id
    JOIN shop.customers c ON c.customer_id = o.customer_id`);
  assert.ok(reversed.includes('aggregate-over-one-to-many-fanout'), 'FROM order must not erase aggregate fan-out');

  assert.doesNotMatch(
    ids(`SELECT sum(o.total_cents)
         FROM shop.orders o
         JOIN shop.customers c ON c.customer_id = o.customer_id`).join(','),
    /aggregate-over-one-to-many-fanout/,
    'repeating lookup rows is not enough when the aggregate reads the non-multiplied side',
  );
  assert.doesNotMatch(
    ids(`SELECT sum(oi.unit_price_cents)
         FROM shop.customers c
         JOIN shop.orders o ON o.customer_id = c.customer_id
         JOIN shop.order_items oi ON oi.order_id = o.order_id`).join(','),
    /aggregate-over-one-to-many-fanout/,
    'an item-grain measure is not invalidated by order-to-item fan-out',
  );
  assert.doesNotMatch(
    ids(`SELECT max(o.total_cents)
         FROM shop.orders o
         JOIN shop.order_items oi ON oi.order_id = o.order_id`).join(','),
    /aggregate-over-one-to-many-fanout/,
    'duplicate-insensitive MAX is not over-counted',
  );
});

test('outer join intent is reported only after proven null rejection', () => {
  const [gate] = corpusFindings('q07');
  assert.equal(gate?.id, 'left-join-null-rejected-in-where');
  assert.deepEqual([gate?.severity, gate?.category], ['high', 'intent']);
  assert.match(gate!.remediation, /Decide the intended population/);
  assert.match(gate!.impact, /rather than an assumed slowdown/);

  assert.doesNotMatch(
    ids(`SELECT c.customer_id
         FROM shop.customers c
         LEFT JOIN shop.orders o ON o.customer_id = c.customer_id
         WHERE o.status = 'complete' OR o.status IS NULL`).join(','),
    /join-null-rejected/,
  );
  assert.doesNotMatch(
    ids(`SELECT c.customer_id
         FROM shop.customers c
         INNER JOIN shop.orders o ON o.customer_id = c.customer_id
         WHERE o.status = 'complete'`).join(','),
    /join-null-rejected/,
  );
});

test('wrapped-column rules separate function, cast, JSON extraction, and matching expression indexes', () => {
  assert.ok(ids(CORPUS.find((query) => query.id.startsWith('q01'))!.sql).includes('non-sargable-function-on-column'));
  assert.ok(ids(CORPUS.find((query) => query.id.startsWith('q09'))!.sql).includes('non-sargable-cast-on-column'));
  assert.deepEqual(
    ids(CORPUS.find((query) => query.id.startsWith('q12'))!.sql).filter((id) => id.startsWith('non-sargable-')),
    [],
    'JSON extraction has its own calibrated finding',
  );

  const lowerSql = `SELECT c.customer_id FROM shop.customers c WHERE lower(c.full_name) = 'customer 1'`;
  assert.ok(ids(lowerSql).includes('non-sargable-function-on-column'));
  assert.ok(
    ids(`SELECT p.product_id FROM shop.products p WHERE p.product_id = 42.5`)
      .includes('non-sargable-cast-on-column'),
    'implicit numeric promotion is a cast hazard, not a function finding',
  );

  const withExpressionIndex = structuredClone(catalog);
  const customers = withExpressionIndex.tables.find((table) => table.name === 'customers')!;
  const expressionIndex: IndexDef = {
    name: 'idx_customers_lower_full_name',
    table: 'customers',
    columns: ['lower((full_name))'],
    expressions: ['lower((full_name))'],
    unique: false,
    method: 'btree',
  };
  customers.indexes.push(expressionIndex);
  assert.doesNotMatch(ids(lowerSql, withExpressionIndex).join(','), /non-sargable-function/);
});

test('leading wildcard and mixed OR findings do not contaminate anchored or fully sargable searches', () => {
  const q02 = corpusFindings('q02');
  // q02 also carries `limit-without-total-order` (its ORDER BY signup_date is
  // non-unique under LIMIT 50); assert the access-path findings by id rather
  // than position so the LIMIT finding does not disturb this regression guard.
  const leadingWildcard = q02.find((finding) => finding.id === 'leading-wildcard-like')!;
  assert.ok(leadingWildcard);
  assert.equal(leadingWildcard.evidence.sqlFragment, `email LIKE '%@example.com'`);
  assert.ok(q02.some((finding) => finding.id === 'mixed-access-paths-under-or'));

  assert.deepEqual(
    ids(`SELECT customer_id FROM shop.customers WHERE full_name LIKE 'Customer 1%'`),
    [],
  );
  assert.deepEqual(
    ids(`SELECT customer_id FROM shop.customers
         WHERE email = 'one@example.com' OR full_name = 'One Person'`),
    [],
  );
});

test('correlated aggregate severity reflects outer cardinality and preserves tie caveats', () => {
  const [repeated] = corpusFindings('q03');
  assert.equal(repeated?.id, 'repeated-correlated-aggregate-scans');
  assert.equal(repeated?.severity, 'low');
  assert.match(repeated!.impact, /about 1,953 outer rows/);
  assert.match(repeated!.caveat!, /not automatically slow/);

  const [topPerGroup] = corpusFindings('q11');
  assert.equal(topPerGroup?.id, 'full-cardinality-correlated-aggregate');
  assert.equal(topPerGroup?.severity, 'high');
  assert.match(topPerGroup!.impact, /2,000,000 outer rows/);
  assert.match(topPerGroup!.caveat!, /every row tied/);

  assert.doesNotMatch(
    ids(`SELECT c.customer_id,
           (SELECT max(o.created_at) FROM shop.orders o WHERE o.customer_id = c.customer_id)
         FROM shop.customers c WHERE c.loyalty_tier = 'gold'`).join(','),
    /repeated-correlated|full-cardinality-correlated/,
    'one scalar aggregate in the projection is not the repeated or top-per-group shape',
  );
});

test('deep OFFSET is calibrated to page depth and retains the API caveat', () => {
  const [finding] = corpusFindings('q04');
  assert.equal(finding?.id, 'deep-offset-pagination');
  assert.equal(finding?.severity, 'high');
  assert.match(finding!.evidence.sqlFragment, /OFFSET 100000/);
  assert.match(finding!.impact, /discard at least 100,000/);
  assert.match(finding!.caveat!, /random page access/);

  assert.deepEqual(
    ids(`SELECT order_id FROM shop.orders ORDER BY order_id LIMIT 20 OFFSET 20`),
    [],
  );
});

test('DISTINCT requires projected aliases to be multiplied and an unprojected join side', () => {
  assert.ok(corpusFindings('q08').some((finding) => finding.id === 'distinct-collapses-existence-fanout'));
  assert.doesNotMatch(
    ids(`SELECT DISTINCT o.order_id
         FROM shop.orders o JOIN shop.customers c ON c.customer_id = o.customer_id`).join(','),
    /distinct-collapses/,
    'a unique-key lookup does not multiply the projected order alias',
  );
  assert.doesNotMatch(
    ids(`SELECT DISTINCT o.order_id, oi.order_item_id
         FROM shop.orders o JOIN shop.order_items oi ON oi.order_id = o.order_id`).join(','),
    /distinct-collapses/,
    'projecting the item-grain key means DISTINCT is not merely hiding an unprojected side',
  );
});

test('JSON scalar extraction respects exact expression indexes and raw GIN is not misrepresented', () => {
  const q12 = CORPUS.find((query) => query.id.startsWith('q12'))!.sql;
  const base = corpusFindings('q12');
  assert.ok(base.some((finding) => finding.id === 'unindexed-json-scalar-extraction'));
  assert.ok(base.some((finding) => finding.id === 'large-input-distinct-aggregate'));

  const withGin = structuredClone(catalog);
  withGin.tables.find((table) => table.name === 'events')!.indexes.push({
    name: 'idx_events_payload_gin',
    table: 'events',
    columns: ['payload'],
    unique: false,
    method: 'gin',
  });
  assert.ok(ids(q12, withGin).includes('unindexed-json-scalar-extraction'), 'raw JSONB GIN does not serve ->> equality directly');

  const withExpression = structuredClone(catalog);
  withExpression.tables.find((table) => table.name === 'events')!.indexes.push({
    name: 'idx_events_utm_source',
    table: 'events',
    columns: [`(payload ->> 'utm_source'::text)`],
    expressions: [`(payload ->> 'utm_source'::text)`],
    unique: false,
    method: 'btree',
  });
  assert.doesNotMatch(ids(q12, withExpression).join(','), /unindexed-json-scalar-extraction/);
});

test('serialized IR retains subquery links used by correctness and correlation rules', () => {
  for (const shortId of ['q03', 'q05', 'q11']) {
    const query = CORPUS.find((candidate) => candidate.id.startsWith(shortId))!;
    const ir = bindQuery(query.sql, catalog);
    const roundTripped = JSON.parse(JSON.stringify(ir));
    assert.deepEqual(detectAntiPatterns(roundTripped, catalog), detectAntiPatterns(ir, catalog), shortId);
  }
});

test('grouping-key HAVING pushdown produces no fabricated performance claim', () => {
  const result = corpusFindings('q10');
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// Fan-out sensitivity is decided by whether feeding a row twice can change the
// answer — not by whether the function is one of the obvious additive ones.
// See docs/AUDIT-2026-08-03.md.
// ---------------------------------------------------------------------------

test('the NOT IN gate respects a NULL guard and catches a NULL literal', () => {
  const fires = (id: string, sql: string) => findings(sql).some((finding) => finding.id === id);

  // False positive: the subquery already filters the NULLs out, which is the
  // repair this finding asks for. Reporting it tells the reader to fix
  // something they have done.
  assert.equal(
    fires('not-in-nullable-subquery', `SELECT c.customer_id FROM shop.customers c
      WHERE c.customer_id NOT IN (
        SELECT e.customer_id FROM shop.events e WHERE e.customer_id IS NOT NULL)`),
    false,
  );
  // The guard must be narrow: a different column, or IS NULL, proves nothing.
  assert.equal(
    fires('not-in-nullable-subquery', `SELECT c.customer_id FROM shop.customers c
      WHERE c.customer_id NOT IN (
        SELECT e.customer_id FROM shop.events e WHERE e.event_id IS NOT NULL)`),
    true,
  );
  assert.equal(
    fires('not-in-nullable-subquery', `SELECT c.customer_id FROM shop.customers c
      WHERE c.customer_id NOT IN (
        SELECT e.customer_id FROM shop.events e WHERE e.customer_id IS NULL)`),
    true,
  );

  // False negative: a NULL in the list makes NOT IN return no rows, ever.
  assert.equal(
    fires('not-in-null-literal', 'SELECT c.customer_id FROM shop.customers c WHERE c.customer_id NOT IN (1, 2, NULL)'),
    true,
  );
  assert.equal(
    fires('not-in-null-literal', 'SELECT c.customer_id FROM shop.customers c WHERE c.customer_id NOT IN (1, 2)'),
    false,
  );
  // The string 'NULL' is an ordinary value, not the keyword.
  assert.equal(
    fires('not-in-null-literal', `SELECT c.customer_id FROM shop.customers c WHERE c.loyalty_tier NOT IN ('NULL', 'x')`),
    false,
  );
});

test('a binary-coercible cast is not reported as blocking the index', () => {
  // PostgreSQL 16.14, btree on a text column: `WHERE email::varchar = '...'`
  // plans as an Index Scan. The cast is pg_cast castmethod='b' — no conversion
  // happens — so advising the reader to remove it is advice about nothing.
  for (const sql of [
    `SELECT c.customer_id FROM shop.customers c WHERE c.email::varchar = 'a@b.c';`,
    `SELECT c.customer_id FROM shop.customers c WHERE c.email::text = 'a@b.c';`,
  ]) {
    assert.deepEqual(findings(sql).map((finding) => finding.id), [], sql);
  }

  // A lossy cast genuinely does fall back to a sequential scan, and still must
  // be reported. Both were confirmed against the same server.
  for (const sql of [
    `SELECT o.order_id FROM shop.orders o WHERE o.created_at::date = DATE '2024-01-01';`,
    `SELECT o.order_id FROM shop.orders o WHERE o.customer_id::text = '42';`,
  ]) {
    assert.ok(
      findings(sql).some((finding) => finding.id === 'non-sargable-cast-on-column'),
      `lossy cast should still be flagged: ${sql}`,
    );
  }
});

test('deep-offset advice matches the ordering the query actually has', () => {
  const offset = (sql: string) => {
    const finding = findings(sql).find((candidate) => candidate.id === 'deep-offset-pagination');
    assert.ok(finding, `deep-offset finding missing for: ${sql}`);
    return finding;
  };

  // No ORDER BY: there are no "ordered rows" to discard and no deterministic
  // ordering to seek over. The real defect is that the pages are not stable.
  const unordered = offset('SELECT o.order_id FROM shop.orders o LIMIT 20 OFFSET 100000;');
  assert.doesNotMatch(unordered.impact, /ordered rows/);
  assert.match(unordered.impact, /overlapping or missing rows|different set on a rerun/i);
  assert.doesNotMatch(unordered.remediation, /over the complete deterministic ordering/);

  // Ordered but with ties: no cursor value identifies a page boundary.
  const ties = offset('SELECT o.order_id FROM shop.orders o ORDER BY o.status LIMIT 20 OFFSET 100000;');
  assert.match(ties.impact, /not proven unique|does not define a total order/i);
  assert.match(ties.remediation, /tiebreaker/i);

  // A unique ordering earns the original advice unchanged.
  const total = offset(
    'SELECT o.order_id FROM shop.orders o ORDER BY o.created_at DESC, o.order_id DESC LIMIT 20 OFFSET 100000;',
  );
  assert.match(total.remediation, /over the complete deterministic ordering/);
  assert.doesNotMatch(total.impact, /not proven unique/);
});

test('duplicate-sensitive aggregates are flagged beyond the additive ones', () => {
  const fanOut = (call: string) => `
    SELECT c.customer_id, ${call}
    FROM shop.customers c
    JOIN shop.orders o ON o.customer_id = c.customer_id
    JOIN shop.order_items oi ON oi.order_id = o.order_id
    GROUP BY c.customer_id;`;
  const flagged = (call: string) =>
    findings(fanOut(call)).some((finding) => finding.id === 'aggregate-over-one-to-many-fanout');

  // Dispersion, regression and distribution aggregates are all weighted by how
  // many rows carry each value, so an uneven fan-out moves them.
  for (const call of [
    'sum(o.total_cents)',
    'stddev(o.total_cents)',
    'variance(o.total_cents)',
    'corr(o.total_cents, o.order_id)',
    'percentile_cont(0.5) WITHIN GROUP (ORDER BY o.total_cents)',
    'mode() WITHIN GROUP (ORDER BY o.total_cents)',
  ]) {
    assert.equal(flagged(call), true, `${call} should be flagged under a fan-out`);
  }

  // Idempotent aggregates must NOT be flagged: repeating a row cannot change
  // min/max, and `x AND x = x`, `x | x = x`. Flagging them is a false positive.
  for (const call of [
    'min(o.total_cents)',
    'max(o.total_cents)',
    'bool_and(o.total_cents > 0)',
    'bit_or(o.total_cents)',
  ]) {
    assert.equal(flagged(call), false, `${call} is idempotent and must not be flagged`);
  }
});

test('col = NULL / <> NULL / != NULL are critical correctness bugs; IS NULL and quoted NULL are safe', () => {
  const fires = (sql: string) => findings(sql);
  const eqNull = fires(`SELECT customer_id FROM shop.customers WHERE email = NULL`);
  assert.ok(eqNull.some((finding) => finding.id === 'null-literal-equality'));
  const [gate] = eqNull.filter((finding) => finding.id === 'null-literal-equality');
  assert.deepEqual([gate?.severity, gate?.category, gate?.actionability, gate?.confidence],
    ['critical', 'correctness', 'required', 'high']);

  // <> NULL and != NULL both fire, as does NULL = col (operand order irrelevant).
  assert.ok(fires(`SELECT customer_id FROM shop.customers WHERE email <> NULL`).some((f) => f.id === 'null-literal-equality'));
  assert.ok(fires(`SELECT order_id FROM shop.orders WHERE coupon_code != NULL`).some((f) => f.id === 'null-literal-equality'));
  assert.ok(fires(`SELECT customer_id FROM shop.customers WHERE NULL = email`).some((f) => f.id === 'null-literal-equality'));

  // The <> / != form must not be reported as the "= returns no rows" shape: its
  // impact prose describes dropping NULL rows, which is the distinct failure mode.
  const neNull = fires(`SELECT order_id FROM shop.orders WHERE coupon_code <> NULL`)
    .find((f) => f.id === 'null-literal-equality')!;
  assert.match(neNull.impact, /drops/i);

  // A quoted 'NULL' string literal is an ordinary value, not the keyword.
  assert.doesNotMatch(
    fires(`SELECT customer_id FROM shop.customers WHERE email = 'NULL'`).map((f) => f.id).join(','),
    /null-literal-equality/,
  );
  // IS NULL / IS NOT NULL are the null-aware forms and must not fire.
  assert.doesNotMatch(
    fires(`SELECT customer_id FROM shop.customers WHERE email IS NULL`).map((f) => f.id).join(','),
    /null-literal-equality/,
  );
  assert.doesNotMatch(
    fires(`SELECT customer_id FROM shop.customers WHERE email IS NOT NULL`).map((f) => f.id).join(','),
    /null-literal-equality/,
  );
  // A NULL inside an IN-list belongs to the existing not-in-null-literal finding
  // (when negated) and must not double-fire as a null-literal-equality.
  assert.doesNotMatch(
    fires(`SELECT customer_id FROM shop.customers WHERE customer_id IN (1, 2, NULL)`).map((f) => f.id).join(','),
    /null-literal-equality/,
  );
});

test('LIMIT without a total ORDER BY is a correctness/intent finding, but a unique key stays clean', () => {
  // No ORDER BY at all: high-severity correctness, required action.
  const noOrder = findings(`SELECT customer_id, email FROM shop.customers LIMIT 10`)
    .find((f) => f.id === 'limit-without-total-order')!;
  assert.ok(noOrder);
  assert.equal(noOrder.severity, 'high');
  assert.equal(noOrder.category, 'correctness');
  assert.equal(noOrder.actionability, 'required');
  assert.match(noOrder.impact, /nondeterministic|unspecified|not reproducible/i);

  // ORDER BY a primary key is a total order: the finding must NOT fire.
  assert.doesNotMatch(
    ids(`SELECT order_id FROM shop.orders ORDER BY order_id LIMIT 10`).join(','),
    /limit-without-total-order/,
  );

  // ORDER BY a non-unique column: medium-severity intent, ties at the boundary.
  const nonUnique = findings(`SELECT order_id FROM shop.orders ORDER BY status LIMIT 10`)
    .find((f) => f.id === 'limit-without-total-order')!;
  assert.ok(nonUnique);
  assert.equal(nonUnique.severity, 'medium');
  assert.equal(nonUnique.category, 'intent');
  assert.equal(nonUnique.actionability, 'optional');
  assert.match(nonUnique.impact, /tie|non-reproducible|unspecified/i);
});

test('GROUP BY a key pinned to one value by WHERE is redundant; an unpinned key is not', () => {
  // q12 corpus shape: GROUP BY 1 where projection 1 is pinned by WHERE.
  assert.ok(corpusFindings('q12').some((f) => f.id === 'redundant-group-by'));

  // Explicit form: GROUP BY the same expression pinned to a literal.
  const pinned = findings(`SELECT e.payload->>'utm_source' AS source, count(*)
     FROM shop.events e
     WHERE e.payload->>'utm_source' = 'email'
     GROUP BY e.payload->>'utm_source'`)
    .find((f) => f.id === 'redundant-group-by')!;
  assert.ok(pinned);
  assert.equal(pinned.severity, 'low');
  assert.equal(pinned.category, 'performance');
  assert.match(pinned.impact, /at most one group|cannot change the result/i);

  // A real grouping dimension (not pinned) must not fire.
  assert.doesNotMatch(
    ids(`SELECT e.event_type, count(*) FROM shop.events e
         WHERE e.occurred_at >= TIMESTAMPTZ '2024-06-01'
         GROUP BY e.event_type`).join(','),
    /redundant-group-by/,
  );

  // column = column equality does not pin to a constant and must not fire.
  assert.doesNotMatch(
    ids(`SELECT c.customer_id, o.order_id FROM shop.customers c
         JOIN shop.orders o ON o.customer_id = c.customer_id
         GROUP BY c.customer_id, o.order_id`).join(','),
    /redundant-group-by/,
  );
});
