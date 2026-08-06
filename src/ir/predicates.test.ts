import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { Catalog, Predicate } from '../types.ts';
import { bindQuery } from './index.ts';
import { literalForcesColumnCast } from './predicates.ts';

const catalog = JSON.parse(
  await readFile(new URL('../../corpus/catalog.json', import.meta.url), 'utf8'),
) as Catalog;

/** All predicates of a WHERE clause built from `sql`, in declaration order. */
function wherePredicates(sql: string): Predicate[] {
  const ir = bindQuery(sql, catalog);
  return ir.blocks.flatMap((block) => block.predicates.filter((predicate) => predicate.clause === 'where'));
}

function first(sql: string): Predicate {
  const predicates = wherePredicates(sql);
  assert.ok(predicates.length, `expected at least one WHERE predicate in: ${sql}`);
  return predicates[0]!;
}

test('classify: a plain column = literal equality is sargable equality with recorded operands', () => {
  const predicate = first(`SELECT customer_id FROM shop.customers WHERE email = 'one@example.com'`);
  assert.equal(predicate.kind, 'equality');
  assert.equal(predicate.sargable, true);
  assert.equal(predicate.negated, undefined);
  assert.ok(predicate.equalityOperands, 'equality operands are recorded for non-negated =');
  assert.equal(predicate.equalityOperands!.rightConstant, true);
  assert.equal(predicate.equalityOperands!.leftConstant, false);
});

test('classify: a range comparison is sargable and is not equality', () => {
  const predicate = first(`SELECT customer_id FROM shop.customers WHERE customer_id > 100`);
  assert.equal(predicate.kind, 'range');
  assert.equal(predicate.sargable, true);
  assert.equal(predicate.equalityOperands, undefined, 'range predicates do not record equality operands');
});

test('classify: an IN-list is sargable in-list', () => {
  const predicate = first(`SELECT customer_id FROM shop.customers WHERE customer_id IN (1, 2, 3)`);
  assert.equal(predicate.kind, 'in-list');
  assert.equal(predicate.sargable, true);
});

test('classify: IS NULL is a sargable null-check, not an equality', () => {
  const predicate = first(`SELECT customer_id FROM shop.customers WHERE email IS NULL`);
  assert.equal(predicate.kind, 'null-check');
  assert.equal(predicate.sargable, true);
  assert.equal(predicate.equalityOperands, undefined);
});

test('assess: an anchored LIKE prefix is sargable; a leading-wildcard LIKE is not', () => {
  const anchored = first(`SELECT customer_id FROM shop.customers WHERE email LIKE 'one%'`);
  assert.equal(anchored.kind, 'like-prefix');
  assert.equal(anchored.sargable, true);

  const leading = first(`SELECT customer_id FROM shop.customers WHERE email LIKE '%one%'`);
  assert.equal(leading.kind, 'like-infix');
  assert.equal(leading.sargable, false);
});

test('assess: a regex with an anchored prefix is treated as a sargable like-prefix', () => {
  const predicate = first(`SELECT customer_id FROM shop.customers WHERE full_name ~ '^Customer'`);
  assert.equal(predicate.kind, 'like-prefix');
  assert.equal(predicate.sargable, true);
});

test('classify: a join-shaped column = column equality is a join, not an equality', () => {
  const ir = bindQuery(
    `SELECT c.customer_id FROM shop.orders o JOIN shop.customers c ON o.customer_id = c.customer_id WHERE o.status = 'complete'`,
    catalog,
  );
  const joinPredicate = ir.blocks
    .flatMap((block) => block.predicates)
    .find((predicate) => predicate.clause === 'on' && predicate.kind === 'join');
  assert.ok(joinPredicate, 'the ON equality is classified as a join predicate');
  assert.equal(joinPredicate!.sargable, true);
  assert.equal(joinPredicate!.equalityOperands, undefined, 'join equalities do not record equality operands');

  // The WHERE filter on the same block is a regular equality.
  const where = ir.blocks
    .flatMap((block) => block.predicates.filter((p) => p.clause === 'where'))
    .find((p) => p.kind === 'equality');
  assert.ok(where);
  assert.equal(where!.equalityOperands!.rightConstant, true);
});

test('assess: a cast on the column side hides it from a btree (non-sargable)', () => {
  // customer_id is integer; ::text forces a cast on the column, so a btree on
  // customer_id cannot serve the comparison. Pins #5's detector, which leans
  // on the same column-vs-cast shape.
  const predicate = first(`SELECT customer_id FROM shop.customers WHERE customer_id::text = '5'`);
  assert.equal(predicate.kind, 'equality');
  assert.equal(predicate.sargable, false);
  assert.match(predicate.sargableReason ?? '', /cast|column/i);
});

test('classify: a subquery predicate is classified as a subquery', () => {
  const predicate = first(`SELECT customer_id FROM shop.customers WHERE customer_id IN (SELECT customer_id FROM shop.orders)`);
  assert.equal(predicate.kind, 'subquery');
});

test('literalForcesColumnCast: an integer column vs a fractional literal forces a cast', () => {
  const number = (value: number) => ({ type: 'number' as const, value });
  assert.equal(literalForcesColumnCast('integer', number(5.5)), true);
  assert.equal(literalForcesColumnCast('bigint', number(5.5)), true);
  // An integer literal against an integer column does NOT force a cast.
  assert.equal(literalForcesColumnCast('integer', number(5)), false);
  // A non-integer column (text) is never forced by a numeric literal.
  assert.equal(literalForcesColumnCast('text', number(5.5)), false);
  // An unknown column type is never forced.
  assert.equal(literalForcesColumnCast(undefined, number(5.5)), false);
  // A non-number literal never forces a numeric cast.
  assert.equal(literalForcesColumnCast('integer', { type: 'string', value: 'x' }), false);
});