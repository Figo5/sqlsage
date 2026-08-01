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

