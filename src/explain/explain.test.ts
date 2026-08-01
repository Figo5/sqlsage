import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CORPUS } from '../../corpus/queries.ts';
import { bindQuery } from '../ir/index.ts';
import type { Catalog, SemanticExplanation } from '../types.ts';
import { explainSemantics } from './index.ts';

const catalog = JSON.parse(await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8')) as Catalog;

function explanation(id: string): SemanticExplanation {
  const query = CORPUS.find((item) => item.id === id);
  assert.ok(query, `missing test fixture ${id}`);
  return explainSemantics(bindQuery(query.sql, catalog), catalog);
}

test('all corpus queries receive substantive, contract-valid semantics', () => {
  for (const query of CORPUS) {
    const result = explanation(query.id);
    assert.ok(result.headline.length > 35, `${query.id}: weak headline`);
    assert.ok(result.steps.length >= 2, `${query.id}: missing logical steps`);
    assert.ok(result.steps.every((step) => step.title.length > 2 && step.detail.endsWith('.')), `${query.id}: malformed step`);
    assert.ok(result.resultShape.grain.length > 25, `${query.id}: weak result grain`);
    assert.equal(result.resultShape.columns.length, bindQuery(query.sql, catalog).blocks.find((block) => block.id === 'main')?.projections.length);
    assert.ok(result.resultShape.columns.every((column) => column.name && column.meaning.length > 20));
    assert.doesNotMatch(JSON.stringify(result), /\b(?:index|indexing|scan|bitmap|heap)\b/i, `${query.id}: physical advice leaked into M2`);
    assert.doesNotMatch(JSON.stringify(result), /placeholder|not implemented/i);
  }
});

test('single-table result grain uses a readable singular row kind', () => {
  const explanation = explainSemantics(
    bindQuery("SELECT customer_id FROM shop.customers WHERE loyalty_tier = 'gold'", catalog),
    catalog,
  );
  assert.match(explanation.resultShape.grain, /qualifying `customer` row/);
  assert.doesNotMatch(explanation.resultShape.grain, /customers row/);
});

test('nullable NOT IN explains three-valued empty-result behavior', () => {
  const result = explanation('q05-not-in-nullable');
  const prose = JSON.stringify(result);
  assert.match(prose, /NULL can poison NOT IN/);
  assert.match(prose, /unknown rather than true/);
  assert.match(result.headline, /empty the result/);
});

test('aggregate fan-out is relation-specific and explains count grain', () => {
  const risky = explanation('q06-fanout-double-count');
  assert.match(risky.headline, /repeat.*`o`/);
  assert.match(JSON.stringify(risky.caveats), /same source value once per matching detail row/);
  assert.match(JSON.stringify(risky.caveats), /count\(\*\) counts the expanded joined rows/);

  const safe = explanation('q01-nonsargable-date');
  assert.doesNotMatch(JSON.stringify(safe.caveats), /aggregate reads multiplied source rows/i);
});

test('outer-join demotion remains an intent question', () => {
  const result = explanation('q07-left-join-demoted');
  assert.match(result.headline, /Intent risk/);
  assert.match(JSON.stringify(result.caveats), /outer join no longer preserves unmatched rows/i);
  assert.match(JSON.stringify(result.caveats), /different result/);
});

test('DISTINCT, timestamp boundaries, deep windows, and top-per-group ties are explicit', () => {
  assert.match(JSON.stringify(explanation('q08-distinct-hides-fanout').caveats), /Duplicates exist before DISTINCT/);
  assert.match(JSON.stringify(explanation('q01-nonsargable-date').caveats), /session time zone/i);
  assert.match(JSON.stringify(explanation('q09-cast-on-column').caveats), /BETWEEN includes both endpoints/);
  assert.match(JSON.stringify(explanation('q04-deep-offset-pagination').caveats), /position-based/);
  assert.match(JSON.stringify(explanation('q11-top-n-per-group').caveats), /Ties at the per-group extreme are preserved/);
});

test('grouped-key HAVING and distinct nullable counts retain their semantic distinctions', () => {
  const having = explanation('q10-having-instead-of-where');
  assert.match(JSON.stringify(having.steps), /grouping key.*calculated aggregate/i);
  assert.doesNotMatch(JSON.stringify(having), /faster|speedup|physical/i);

  const distinct = explanation('q12-jsonb-and-unbounded-sort');
  assert.match(distinct.resultShape.grain, /At most one row/);
  assert.match(JSON.stringify(distinct.caveats), /distinct count ignores NULL values/i);
  assert.match(JSON.stringify(distinct.caveats), /grouping key is positional/i);
});
