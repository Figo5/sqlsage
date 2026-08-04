import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CORPUS } from '../../corpus/queries.ts';
import { bindQuery } from '../ir/index.ts';
import type { Catalog, ExecutionAnalysis } from '../types.ts';
import { predictExecution } from './index.ts';

const catalog = JSON.parse(await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8')) as Catalog;

function prediction(id: string): ExecutionAnalysis {
  const query = CORPUS.find((item) => item.id === id);
  assert.ok(query, `missing test fixture ${id}`);
  return predictExecution(bindQuery(query.sql, catalog), catalog);
}

test('all corpus queries receive substantive, calibrated execution predictions', () => {
  for (const query of CORPUS) {
    const result = prediction(query.id);
    const relationCount = bindQuery(query.sql, catalog).blocks.reduce((count, block) => count + block.relations.length, 0);
    assert.equal(result.accessPaths.length, relationCount, `${query.id}: one path per relation`);
    assert.ok(result.accessPaths.every((path) => path.reason.startsWith('Offline prediction')), `${query.id}: uncalibrated path prose`);
    assert.ok(result.dominantCosts.length >= 1, `${query.id}: no dominant work`);
    assert.ok(result.scalability.summary.startsWith('Offline prediction:'));
    assert.match(result.scalability.complexity ?? '', /^O\(.+\)$/);
    assert.doesNotMatch(JSON.stringify(result), /placeholder|not implemented/i);
    assert.doesNotMatch(JSON.stringify(result), /\b(?:actual(?:ly)?|observed|measured|milliseconds?|\d+(?:\.\d+)?\s*ms\b|buffers? hit)\b/i, `${query.id}: runtime evidence leaked into offline output`);
  }
});

test('non-sargable predicates and leading-wildcard OR stay sequential', () => {
  const month = prediction('q01-nonsargable-date');
  assert.equal(month.accessPaths.find((path) => path.relation === 'o')?.path, 'seq-scan');
  assert.match(month.accessPaths.find((path) => path.relation === 'o')?.reason ?? '', /date_trunc/);

  const search = prediction('q02-leading-wildcard-or');
  assert.equal(search.accessPaths[0]?.path, 'seq-scan');
  assert.match(search.scalability.summary, /linearly/i);
});

test('two correlated aggregates remain two repeated subplans with different coverage', () => {
  const result = prediction('q03-correlated-scalar-subquery');
  const subplans = result.joinStrategies.filter((join) => /correlated subplan/.test(join.join));
  assert.equal(subplans.length, 2);
  assert.ok(subplans.every((join) => join.estimatedRows === 1953));
  assert.equal(result.accessPaths.find((path) => path.relation === 'o (sub:1)')?.path, 'index-only-scan');
  assert.equal(result.accessPaths.find((path) => path.relation === 'o2 (sub:2)')?.path, 'index-scan');
  assert.match(JSON.stringify(result.dominantCosts), /Per-invocation work must be multiplied/);
});

test('deep OFFSET predicts top-N at offset plus limit and depth scaling', () => {
  const result = prediction('q04-deep-offset-pagination');
  assert.match(JSON.stringify(result.dominantCosts), /100,020/);
  assert.match(JSON.stringify(result.dominantCosts), /discard 100,000/);
  assert.match(result.scalability.summary, /page depth 100,000/);
});

test('nullable NOT IN is a hashed subplan risk, never an anti-join claim', () => {
  const result = prediction('q05-not-in-nullable');
  const prose = JSON.stringify(result);
  assert.match(prose, /hashed membership SubPlan/);
  assert.match(prose, /must not be described as a hash anti-join/);
  assert.match(prose, /change the outer result from many rows to zero/);
});

test('fan-out magnitude drives q06 join and aggregation work', () => {
  const result = prediction('q06-fanout-double-count');
  const largeJoin = result.joinStrategies.find((join) => join.join.includes('o INNER oi'));
  assert.equal(largeJoin?.algorithm, 'hash-join');
  assert.ok((largeJoin?.estimatedRows ?? 0) >= 4_500_000);
  assert.match(JSON.stringify(result.dominantCosts), /join-expanded|repeats/);
  assert.match(result.scalability.summary, /matching child rows/);
});

test('outer-join demotion is predicted without treating it as an execution barrier', () => {
  const result = prediction('q07-left-join-demoted');
  const join = result.joinStrategies[0];
  assert.equal(join?.algorithm, 'nested-loop');
  assert.match(join?.reason ?? '', /execute this as an inner join/);
  assert.match(join?.reason ?? '', /no outer-join execution barrier/);
});

test('LEFT JOIN estimation preserves the left-side cardinality for partial, zero, and complete right matches', () => {
  const cases = [
    `SELECT c.customer_id, p.name FROM shop.customers c LEFT JOIN shop.products p ON c.customer_id = p.product_id AND p.is_discontinued = true`,
    `SELECT c.customer_id, p.name FROM shop.customers c LEFT JOIN shop.products p ON c.customer_id = p.product_id AND p.product_id < 0`,
    `SELECT c.customer_id, p.name FROM shop.customers c LEFT JOIN shop.products p ON c.customer_id = p.product_id`,
  ];
  for (const sql of cases) {
    const result = predictExecution(bindQuery(sql, catalog), catalog);
    const join = result.joinStrategies.find((item) => /LEFT/.test(item.join));
    assert.equal(join?.estimatedRows, 200_000, sql);
  }
});

test('an inner join keeps the filtered estimate without the outer-join floor', () => {
  const inner = predictExecution(
    bindQuery('SELECT c.customer_id, p.name FROM shop.customers c JOIN shop.products p ON c.customer_id = p.product_id AND p.is_discontinued = true', catalog),
    catalog,
  );
  const join = inner.joinStrategies.find((item) => /INNER/.test(item.join));
  assert.equal(join?.estimatedRows, 100_000);
});

test('a WHERE predicate that null-rejects the right side removes the outer-join floor', () => {
  const demoted = predictExecution(
    bindQuery('SELECT c.customer_id, p.name FROM shop.customers c LEFT JOIN shop.products p ON c.customer_id = p.product_id WHERE p.is_discontinued = true', catalog),
    catalog,
  );
  const join = demoted.joinStrategies.find((item) => /LEFT/.test(item.join));
  assert.equal(join?.estimatedRows, 100_000);
  assert.match(join?.reason ?? '', /execute this as an inner join/);
});

test('a non-unique right side still never drops a LEFT join below the left-side cardinality', () => {
  const result = predictExecution(
    bindQuery('SELECT c.customer_id, o.order_id FROM shop.customers c LEFT JOIN shop.orders o ON o.customer_id = c.customer_id AND o.status = \'complete\'', catalog),
    catalog,
  );
  const join = result.joinStrategies.find((item) => /LEFT/.test(item.join));
  assert.ok(join?.estimatedRows !== undefined && join.estimatedRows >= 200_000, `expected >= 200,000, got ${join?.estimatedRows}`);
});

test('DISTINCT and count DISTINCT name pre-deduplication work and estimate risk', () => {
  const distinct = prediction('q08-distinct-hides-fanout');
  assert.match(JSON.stringify(distinct.dominantCosts), /DISTINCT operates after the joins/);
  assert.ok(distinct.estimationRisks.some((risk) => risk.direction === 'over' && /DISTINCT/.test(risk.where)));

  const counted = prediction('q12-jsonb-and-unbounded-sort');
  assert.match(JSON.stringify(counted.dominantCosts), /deduplicate aggregate inputs/);
  assert.match(JSON.stringify(counted.memoryRisks), /no current spill is asserted/i);
});

test('grouping-key HAVING is pushed to the existing access path', () => {
  const result = prediction('q10-having-instead-of-where');
  const path = result.accessPaths.find((item) => item.relation === 'o');
  assert.equal(path?.path, 'bitmap-heap-scan');
  assert.equal(path?.usingIndex, 'idx_orders_customer_id');
  assert.match(path?.reason ?? '', /o\.customer_id < 1000/);
  assert.doesNotMatch(JSON.stringify(result), /move.*WHERE|speedup|all 2,000,000.*before/i);
});

test('per-row correlated max exposes two-million-loop and sum-of-squares scaling', () => {
  const result = prediction('q11-top-n-per-group');
  const subplan = result.joinStrategies.find((join) => /correlated subplan/.test(join.join));
  assert.equal(subplan?.estimatedRows, 2_000_000);
  assert.match(subplan?.reason ?? '', /2,000,000/);
  assert.match(result.scalability.complexity ?? '', /Σk²/);
  assert.equal(result.dominantCosts[0]?.what.startsWith('Repeat max'), true);
});

test('a column=column equality keeps the grouped output estimate large', () => {
  const notFixed = predictExecution(
    bindQuery('SELECT o.total_cents, count(*) FROM shop.orders o WHERE o.total_cents = o.customer_id GROUP BY o.total_cents ORDER BY count(*) DESC', catalog),
    catalog,
  );
  assert.ok(notFixed.dominantCosts.some((cost) => /Order all result candidates/.test(cost.what)), 'col=col group must not collapse to one row');
  assert.ok(notFixed.dominantCosts.some((cost) => /full sort or an order-aware aggregate|qualifying rows still compete/.test(cost.why)));
});

test('a constant equality collapses the grouped output estimate to a single row', () => {
  const fixed = predictExecution(
    bindQuery("SELECT o.status, count(*) FROM shop.orders o WHERE o.status = 'complete' GROUP BY o.status ORDER BY count(*) DESC", catalog),
    catalog,
  );
  assert.ok(!fixed.dominantCosts.some((cost) => /Order all result candidates/.test(cost.what)), 'fixed group needs no full sort');
});

// ---------------------------------------------------------------------------
// An index leading with the right column is not enough — the method has to
// implement the operator. Expectations below were taken from PostgreSQL 16.14
// on a 200k-row table, not from the manual. See docs/AUDIT-2026-08-03.md P0-3.
// ---------------------------------------------------------------------------

function withIndex(table: string, index: Record<string, unknown>): Catalog {
  const clone = structuredClone(catalog);
  (clone.tables.find((candidate) => candidate.name === table)!.indexes as unknown[]).push(index);
  return clone;
}

function pathFor(sql: string, source: Catalog) {
  return predictExecution(bindQuery(sql, source), source).accessPaths[0]!;
}

test('a hash index is not credited with serving a range scan', () => {
  // PostgreSQL 16.14 answers `total_cents > 5000` with a Seq Scan; the hash
  // index is not used at all, because hash implements equality only.
  const source = withIndex('orders', {
    name: 'idx_orders_total_hash', table: 'orders', columns: ['total_cents'],
    unique: false, method: 'hash',
  });
  const range = pathFor('SELECT o.order_id FROM shop.orders o WHERE o.total_cents > 5000;', source);
  assert.equal(range.path, 'seq-scan');
  assert.equal(range.usingIndex, undefined);
  // Reporting "no index begins with that column" would be false and would send
  // the reader to create an index they already have.
  assert.match(range.reason, /is a HASH index, which does not implement/);
  assert.doesNotMatch(range.reason, /no existing index begins/);

  // The same index under equality is genuinely usable.
  const equality = pathFor('SELECT o.order_id FROM shop.orders o WHERE o.total_cents = 700;', source);
  assert.equal(equality.usingIndex, 'idx_orders_total_hash');
});

test('a GIN index is credited for the containment operator it exists to serve', () => {
  const source = withIndex('events', {
    name: 'idx_events_payload_gin', table: 'events', columns: ['payload'],
    unique: false, method: 'gin',
  });
  const path = pathFor(
    `SELECT e.event_id FROM shop.events e WHERE e.payload @> '{"utm_source":"ads"}';`,
    source,
  );
  assert.equal(path.usingIndex, 'idx_events_payload_gin');
  // GIN reaches the heap through a bitmap and cannot drive an index-only scan.
  assert.equal(path.path, 'bitmap-heap-scan');
  assert.match(path.reason, /no ordered entries and no visibility-map support/);
});

test('CROSS JOIN LATERAL is not assumed to fan out', () => {
  const join = (sql: string) => bindQuery(sql, catalog).blocks[0]!.joins[0]!;

  // The lateral is keyed on the outer relation's primary key and returns at
  // most one row per outer row, so nothing is multiplied. CROSS JOIN LATERAL is
  // spelled as a cross join but is not one: its condition lives inside the
  // subquery, and the unconditional cross-join rule used to answer it first.
  const none = join(`
    SELECT c.customer_id, x.email FROM shop.customers c
    CROSS JOIN LATERAL (
      SELECT c2.email FROM shop.customers c2 WHERE c2.customer_id = c.customer_id
    ) x;`);
  assert.equal(none.fanOut, false);
  assert.equal(none.fanOutSide, 'none');
  assert.deepEqual(none.multipliedRelations ?? [], []);

  // A lateral that can return many rows per outer row does multiply the left
  // input — the correlation key is not unique on orders.
  const left = join(`
    SELECT c.customer_id, x.order_id FROM shop.customers c
    CROSS JOIN LATERAL (
      SELECT o.order_id FROM shop.orders o WHERE o.customer_id = c.customer_id
    ) x;`);
  assert.equal(left.fanOut, true);
  assert.equal(left.fanOutSide, 'left');
  assert.deepEqual(left.multipliedRelations, ['c']);

  // A genuine cross join still multiplies unconditionally.
  const cross = join('SELECT c.customer_id, p.product_id FROM shop.customers c CROSS JOIN shop.products p;');
  assert.equal(cross.fanOut, true);
  assert.equal(cross.fanOutSide, 'both');
  assert.match(cross.fanOutReason ?? '', /multiplies unconditionally/);
});

test('a HAVING aggregate is never pushed into the scan, whatever the function', () => {
  // The aggregate's argument is the grouping key, so the "every column is
  // grouped" test passes and only the aggregate guard stands between this
  // condition and the scan. A per-row filter cannot evaluate it: the value does
  // not exist until the group is complete.
  for (const call of [
    'sum(o.customer_id)',
    'stddev(o.customer_id)',
    'variance(o.customer_id)',
    'percentile_cont(0.5) WITHIN GROUP (ORDER BY o.customer_id)',
    'mode() WITHIN GROUP (ORDER BY o.customer_id)',
  ]) {
    const ir = bindQuery(
      `SELECT o.customer_id FROM shop.orders o GROUP BY o.customer_id HAVING ${call} > 100;`,
      catalog,
    );
    assert.deepEqual(
      ir.blocks[0]!.relations[0]!.localPredicates.map((predicate) => predicate.sql),
      [],
      `${call} leaked into scan-level pushdown`,
    );
  }

  // An aggregate-free HAVING conjunct over a grouping key still pushes down —
  // that is a real PostgreSQL behaviour and must not be lost to the fix.
  const pushable = bindQuery(
    `SELECT o.customer_id FROM shop.orders o GROUP BY o.customer_id HAVING o.customer_id > 100;`,
    catalog,
  );
  assert.equal(pushable.blocks[0]!.relations[0]!.localPredicates.length, 1);
});

test('a containment predicate is classified apart from unrecognised shapes', () => {
  const ir = bindQuery(
    `SELECT e.event_id FROM shop.events e WHERE e.payload @> '{"a":1}';`,
    catalog,
  );
  const predicate = ir.blocks[0]!.relations[0]!.localPredicates[0]!;
  assert.equal(predicate.kind, 'containment');
  assert.equal(predicate.sargable, true);
});

