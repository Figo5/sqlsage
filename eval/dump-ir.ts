/**
 * Human-readable M1 inspection harness.
 *
 * Usage:
 *   node eval/dump-ir.ts                 # concise dump of the full corpus
 *   node eval/dump-ir.ts q06             # one query (substring match)
 *   node eval/dump-ir.ts q06 --json      # complete QueryIR JSON
 *   node eval/dump-ir.ts --check          # executable corpus + edge assertions
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CORPUS } from '../corpus/queries.ts';
import {
  analyzeNullRejection,
  bindQuery,
  columnNullability,
  nestedBlockIds,
  outerJoinDemotions,
} from '../src/ir/index.ts';
import type { Catalog, QueryBlockIR, QueryIR, ResolvedColumnRef } from '../src/types.ts';

const catalog = JSON.parse(await readFile(new URL('../corpus/catalog.json', import.meta.url), 'utf8')) as Catalog;
const selector = process.argv.slice(2).find((a) => !a.startsWith('--'));
const json = process.argv.includes('--json');
const check = process.argv.includes('--check');
const selected = selector ? CORPUS.filter((q) => q.id.includes(selector)) : CORPUS;

if (!check && selected.length === 0) {
  console.error(`No corpus query matches ${selector}.`);
  process.exitCode = 1;
}

if (check) {
  const assertions = runChecks();
  console.log(`M1 checks passed: ${assertions} assertions across 12 corpus queries plus synthetic and adversarial variants.`);
} else {
  for (const query of selected) {
    const ir = bindQuery(query.sql, catalog);
    if (json) {
      console.log(JSON.stringify({ id: query.id, ir }, null, 2));
      continue;
    }
    printIr(query.id, ir);
  }
}

function runChecks(): number {
  let assertions = 0;
  const ok = (condition: unknown, message: string): asserts condition => {
    assertions++;
    assert.ok(condition, message);
  };
  const equal = (actual: unknown, expected: unknown, message: string): void => {
    assertions++;
    assert.deepEqual(actual, expected, message);
  };
  const byId = new Map(CORPUS.map((q) => [q.id.slice(0, 3), bindQuery(q.sql, catalog)]));
  const ir = (id: string): QueryIR => byId.get(id)!;
  const main = (id: string) => ir(id).blocks.find((b) => b.id === 'main')!;

  equal(byId.size, 12, 'the whole corpus must be represented');
  for (const [id, queryIr] of byId) {
    equal(queryIr.statementType, 'select', `${id}: statement type`);
    ok(queryIr.blocks.some((b) => b.id === queryIr.rootBlockId), `${id}: root block exists`);
    equal(queryIr.bindingErrors, [], `${id}: no binding errors`);
    for (const block of queryIr.blocks) {
      for (const predicate of block.predicates) {
        ok(predicate.sql.length > 0, `${id}/${block.id}: predicate source text`);
        ok(!!predicate.sargableReason, `${id}/${block.id}: calibrated sargability reason`);
        ok(predicate.columns.every((c) => !c.unresolved), `${id}/${block.id}: predicate columns resolve`);
      }
      for (const projection of block.projections) {
        ok(projection.sql.length > 0, `${id}/${block.id}: projection source text`);
        ok(projection.columns.every((c) => !c.unresolved), `${id}/${block.id}: projection columns resolve`);
      }
    }
  }

  const q01Date = main('q01').predicates.find((p) => p.sql.includes('date_trunc'))!;
  const q01Status = main('q01').predicates.find((p) => p.sql.includes('.status'))!;
  equal(q01Date.sargable, false, 'q01: wrapped timestamp is not sargable');
  ok(q01Date.sargableReason!.includes('STABLE') && q01Date.sargableReason!.includes('TimeZone'), 'q01: expression-index caveat');
  equal(q01Status.sargable, true, 'q01: bare equality is sargable');
  ok(Math.abs(q01Status.selectivity! - 0.8499333) < 1e-8, 'q01: status selectivity comes from pg_stats');

  const q02 = main('q02').predicates[0]!;
  equal(q02.sargable, false, 'q02: one non-sargable OR branch defeats the whole OR');
  ok(q02.sargableReason!.includes('begins with a wildcard'), 'q02: infix branch explained');
  ok(q02.sargableReason!.includes('text_pattern_ops'), 'q02: prefix branch retains collation caveat');

  equal(ir('q03').blocks.length, 3, 'q03: two scalar subquery blocks');
  equal(ir('q03').blocks.filter((b) => b.correlated).length, 2, 'q03: both scalar subqueries are correlated');
  ok(main('q03').projections[2]!.sql.startsWith('(SELECT') && main('q03').projections[2]!.sql.endsWith(')'), 'q03: scalar-subquery delimiters recovered');

  equal([main('q04').limit, main('q04').offset], [20, 100000], 'q04: deep pagination literals');
  equal(main('q04').orderBy.map((o) => [o.column?.column, o.direction]), [['created_at', 'desc'], ['order_id', 'desc']], 'q04: composite order binding');

  const q05 = main('q05').predicates[0]!;
  equal([q05.kind, q05.negated, q05.sargable], ['subquery', true, false], 'q05: NOT IN classification');
  equal(nestedBlockIds(q05), ['sub:1'], 'q05: subquery linkage');
  ok(q05.sql.endsWith(')'), 'q05: NOT IN source closes its subquery');
  ok(catalog.tables.find((t) => t.name === 'events')!.columns.find((c) => c.name === 'customer_id')!.nullable, 'q05: child projection is catalog-nullable');
  equal(columnNullability(ir('q05').blocks[1]!.projections[0]!.columns[0]!)?.nullable, true, 'q05: nullable child projection is available to semantics');

  equal(main('q06').joins.map((j) => j.fanOut), [true, true], 'q06: both one-to-many joins fan out');
  ok(main('q06').joins[1]!.fanOutReason!.includes('rows per value'), 'q06: fan-out is quantified from pg_stats');
  equal(main('q06').aggregates.find((a) => a.func === 'sum')!.sql, 'sum(o.total_cents)', 'q06: multiplied aggregate origin retained');

  equal(outerJoinDemotions(ir('q07')).length, 1, 'q07: WHERE demotes LEFT JOIN');
  // This was asserted `false` while fan-out meant "the RIGHT side is not unique".
  // Under the orientation-independent definition it is `true` with side='right':
  // products.product_id is a primary key, so no order_item row is duplicated, but
  // the left input is not unique on product_id, so each *product* row is repeated.
  // Verified on the live server: that join emits 19,935 rows over 250 distinct
  // products — each product row appears ~79.7x, so an aggregate over p's columns
  // would be over-counted by that factor.
  equal(main('q08').joins.map((j) => j.fanOut), [true, true, true], 'q08: fan-out chain and repeated product rows');
  equal(main('q08').joins[2]!.fanOutSide, 'right', 'q08: product lookup repeats the right side, not the left');
  ok(main('q08').joins[2]!.multipliedRelations!.includes('p'), 'q08: products named as the multiplied relation');
  equal(main('q08').distinct, true, 'q08: DISTINCT retained');

  const q09 = main('q09').predicates[0]!;
  equal(q09.sargable, false, 'q09: cast-on-column blocks bare index');
  ok(q09.sargableReason!.includes('STABLE') && q09.sargableReason!.includes('TimeZone'), 'q09: timestamptz::date immutability caveat');
  ok(main('q09').groupByExpressions![0]!.sql.includes('created_at::date'), 'q09: group expression retained');
  equal(main('q09').groupBy[0]!.unresolved, undefined, 'q09: valid group expression lineage is not mislabeled as a binding failure');

  const q10Aggregate = main('q10').having.find((p) => p.sql.includes('count'))!;
  const q10Key = main('q10').having.find((p) => p.sql.includes('customer_id'))!;
  equal(q10Aggregate.sargable, false, 'q10: aggregate HAVING condition is post-group');
  ok(q10Aggregate.sargableReason!.includes('after grouping'), 'q10: aggregate reason is not misreported as constant');
  equal(main('q10').relations[0]!.localPredicates.includes(q10Key), true, 'q10: grouped-key HAVING predicate is pushable');

  equal(ir('q11').blocks.find((b) => b.id === 'sub:1')!.correlated, true, 'q11: max subquery is correlated');
  ok(main('q11').predicates[0]!.sql.endsWith(')'), 'q11: scalar comparison source closes its subquery');

  const q12Json = main('q12').predicates.find((p) => p.sql.includes('payload'))!;
  const q12In = main('q12').predicates.find((p) => p.kind === 'in-list')!;
  equal([q12Json.sargable, q12In.sargable], [false, true], 'q12: expression equality vs constant IN list');
  ok(q12Json.sargableReason!.includes('containment (@>)'), 'q12: GIN requires a predicate rewrite');
  equal(main('q12').groupByExpressions![0]!.ordinal, 1, 'q12: GROUP BY ordinal is retained losslessly');
  equal(main('q12').groupByExpressions![0]!.columns[0]!.column, 'payload', 'q12: ordinal resolves to expression lineage');
  equal(main('q12').aggregates.find((a) => a.distinct)!.func, 'count', 'q12: DISTINCT aggregate retained');

  const like = bindQuery(
    `SELECT customer_id FROM shop.customers WHERE full_name LIKE 'Customer 1%' AND email LIKE '%@example.com'`,
    catalog,
  );
  equal(like.blocks[0]!.predicates.map((p) => [p.kind, p.sargable]), [['like-prefix', true], ['like-infix', false]], 'edge: prefix versus infix LIKE');
  ok(like.blocks[0]!.predicates[0]!.sargableReason!.includes('text_pattern_ops'), 'edge: prefix LIKE collation caveat');

  const notExists = bindQuery(
    `SELECT c.customer_id FROM shop.customers c WHERE NOT EXISTS (SELECT 1 FROM shop.events e WHERE e.customer_id = c.customer_id)`,
    catalog,
  );
  equal([notExists.blocks[0]!.predicates[0]!.kind, notExists.blocks[0]!.predicates[0]!.negated], ['subquery', true], 'edge: NOT EXISTS classification');
  ok(notExists.blocks[0]!.predicates[0]!.sargableReason!.includes('anti-join'), 'edge: NOT EXISTS reason');
  equal(notExists.blocks[1]!.correlationRefs?.map((r) => `${r.alias}.${r.column}`), ['c.customer_id'], 'edge: NOT EXISTS correlation');

  const cte = bindQuery(
    `WITH recent AS (SELECT o.customer_id, max(o.created_at) AS last_at FROM shop.orders o GROUP BY o.customer_id) SELECT c.email, r.last_at FROM shop.customers c JOIN recent r ON r.customer_id = c.customer_id`,
    catalog,
  );
  equal(cte.blocks.map((b) => [b.id, b.kind]), [['cte:recent', 'cte'], ['main', 'select']], 'edge: CTE block structure');
  equal(cte.blocks[1]!.joins[0]!.fanOut, false, 'edge: grouped CTE uniqueness prevents fan-out');

  const window = bindQuery(
    `SELECT o.customer_id, row_number() OVER (PARTITION BY o.customer_id ORDER BY o.created_at DESC NULLS LAST) AS rn FROM shop.orders o ORDER BY rn`,
    catalog,
  ).blocks[0]!;
  equal(window.windowFunctions[0]!.partitionBy[0]!.column, 'customer_id', 'edge: window partition binding');
  equal(window.windowFunctions[0]!.orderBy, ['o.created_at DESC NULLS LAST'], 'edge: window order binding');
  equal(window.orderBy[0]!.column, null, 'edge: ORDER BY computed output alias is intentionally not a base column');

  const groupAlias = bindQuery(
    `SELECT o.created_at::date AS day, count(*) FROM shop.orders o GROUP BY day`,
    catalog,
  );
  equal(groupAlias.bindingErrors, [], 'edge: GROUP BY can resolve a computed output alias');
  ok(groupAlias.blocks[0]!.groupByExpressions![0]!.sql === 'day', 'edge: GROUP BY alias source is retained');
  equal(groupAlias.blocks[0]!.groupByExpressions![0]!.columns[0]!.column, 'created_at', 'edge: GROUP BY alias retains producing-expression lineage');

  const groupInputWins = bindQuery(
    `SELECT o.customer_id AS status, count(*) FROM shop.orders o GROUP BY status`,
    catalog,
  );
  equal(groupInputWins.blocks[0]!.groupBy[0]!.column, 'status', 'edge: GROUP BY input column wins over colliding output alias');

  const ambiguous = bindQuery(
    `SELECT c.customer_id FROM shop.customers c WHERE EXISTS (SELECT 1 FROM shop.orders o JOIN shop.customers c2 ON c2.customer_id = o.customer_id WHERE customer_id > 0)`,
    catalog,
  );
  ok(ambiguous.bindingErrors.some((e) => e.message.includes('ambiguous')), 'edge: nearest-scope ambiguity is reported');
  equal(ambiguous.blocks.find((b) => b.id === 'sub:1')!.correlated, undefined, 'edge: ambiguity does not fall through into false correlation');

  const fullJoin = bindQuery(
    `SELECT * FROM shop.customers c FULL JOIN shop.orders o ON o.status = 'complete'`,
    catalog,
  ).blocks[0]!;
  equal(fullJoin.relations.flatMap((r) => r.localPredicates), [], 'edge: one-sided FULL JOIN ON predicate is not pushed into a preserved scan');

  const fractional = bindQuery(`SELECT product_id FROM shop.products WHERE product_id = 42.5`, catalog).blocks[0]!.predicates[0]!;
  equal(fractional.sargable, false, 'edge: fractional numeric literal implicitly casts integer column');
  ok(fractional.sargableReason!.includes('promotes the column to numeric'), 'edge: implicit-cast reason');

  const notBetween = bindQuery(`SELECT product_id FROM shop.products WHERE product_id NOT BETWEEN 100 AND 200`, catalog).blocks[0]!.predicates[0]!;
  equal(notBetween.sargable, true, 'edge: NOT BETWEEN can use two btree ranges');
  ok(notBetween.sargableReason!.includes('BitmapOr'), 'edge: NOT BETWEEN plan shape is calibrated');

  // Round-2: relation-aware SQL three-valued null rejection. These are fresh
  // q07 shapes, not corpus-string matches.
  const outerVariant = (where: string): QueryIR => bindQuery(
    `SELECT c.customer_id FROM shop.customers c LEFT JOIN shop.orders o ON o.customer_id = c.customer_id WHERE ${where}`,
    catalog,
  );
  const wherePredicate = (queryIr: QueryIR) => queryIr.blocks.find((b) => b.id === 'main')!.predicates.find((p) => p.clause === 'where')!;

  const coalesceOuter = outerVariant(`coalesce(o.status, 'complete') = 'complete'`);
  equal(analyzeNullRejection(wherePredicate(coalesceOuter), 'o').outcome, 'tolerant', 'adversarial: COALESCE can preserve a null-extended row');
  equal(outerJoinDemotions(coalesceOuter), [], 'adversarial: COALESCE predicate does not falsely demote LEFT JOIN');

  const unrelatedNull = outerVariant(`o.status = 'complete' OR c.email IS NULL`);
  equal(analyzeNullRejection(wherePredicate(unrelatedNull), 'o').outcome, 'rejecting', 'adversarial: unrelated NOT NULL IS NULL branch is false');
  equal(outerJoinDemotions(unrelatedNull).length, 1, 'adversarial: OR with impossible preserved-side branch still demotes');

  const nullableOtherSide = outerVariant(`o.status = 'complete' OR c.last_login_at IS NULL`);
  equal(analyzeNullRejection(wherePredicate(nullableOtherSide), 'o').outcome, 'tolerant', 'nearby: nullable preserved-side IS NULL can retain unmatched rows');
  equal(outerJoinDemotions(nullableOtherSide), [], 'nearby: genuinely tolerant cross-relation OR is not demoted');

  const sameAliasNull = outerVariant(`o.status = 'complete' OR o.status IS NULL`);
  equal(analyzeNullRejection(wherePredicate(sameAliasNull), 'o').possibleTruths, ['true'], 'nearby: same-alias IS NULL makes OR true after substitution');
  equal(outerJoinDemotions(sameAliasNull), [], 'nearby: canonical null-tolerant OR is preserved');

  const strictFunction = outerVariant(`lower(o.status) = 'complete'`);
  equal(analyzeNullRejection(wherePredicate(strictFunction), 'o').outcome, 'rejecting', 'nearby: known STRICT function propagates substituted NULL');
  equal(outerJoinDemotions(strictFunction).length, 1, 'nearby: strict wrapper remains provably null-rejecting');

  const unknownFunction = outerVariant(`mystery_null_policy(o.status) = 'complete'`);
  equal(analyzeNullRejection(wherePredicate(unknownFunction), 'o').outcome, 'unknown', 'adversarial: unknown function NULL policy stays unknown');
  equal(outerJoinDemotions(unknownFunction), [], 'adversarial: unknown function never causes a categorical demotion');

  const caseOuter = outerVariant(`CASE WHEN o.status IS NULL THEN true ELSE false END`);
  equal(analyzeNullRejection(wherePredicate(caseOuter), 'o').outcome, 'tolerant', 'nearby: CASE branches are evaluated under three-valued semantics');
  equal(outerJoinDemotions(caseOuter), [], 'nearby: CASE-proven tolerant predicate does not demote');

  const dominatingFalse = outerVariant(`o.status = 'complete' AND mystery_null_policy(o.status)`);
  equal(analyzeNullRejection(wherePredicate(dominatingFalse), 'o').outcome, 'rejecting', 'nearby: UNKNOWN AND unknown-function result can never be TRUE');
  equal(outerJoinDemotions(dominatingFalse).length, 1, 'nearby: unknown subexpression does not hide a proof supplied by 3VL');

  // Parser locations for Boolean tests historically included the operand's
  // closing parenthesis but omitted its opening one. Preserve balanced source
  // and check PostgreSQL's exact three-valued truth tables, both before and
  // after the bound-AST identity cache is lost to serialization.
  const parenthesizedTrue = outerVariant(`(o.status = 'complete') IS TRUE`);
  const parenthesizedTruePredicate = wherePredicate(parenthesizedTrue);
  equal(parenthesizedTruePredicate.sql, `(o.status = 'complete') IS TRUE`, 'round-3: parenthesized IS TRUE source is balanced and faithful');
  equal(analyzeNullRejection(parenthesizedTruePredicate, 'o').outcome, 'rejecting', 'round-3: UNKNOWN IS TRUE rejects a null-extended row');
  equal(outerJoinDemotions(parenthesizedTrue).length, 1, 'round-3: parenthesized IS TRUE demotes the LEFT JOIN');

  const parenthesizedFalse = outerVariant(`(o.status = 'complete') IS FALSE`);
  const parenthesizedFalsePredicate = wherePredicate(parenthesizedFalse);
  equal(parenthesizedFalsePredicate.sql, `(o.status = 'complete') IS FALSE`, 'round-3: parenthesized IS FALSE source is balanced and faithful');
  equal(analyzeNullRejection(parenthesizedFalsePredicate, 'o').possibleTruths, ['false'], 'round-3: UNKNOWN IS FALSE is FALSE, not UNKNOWN');
  equal(outerJoinDemotions(parenthesizedFalse).length, 1, 'round-3: parenthesized IS FALSE demotes the LEFT JOIN');

  const parenthesizedNotTrue = outerVariant(`(o.status = 'complete') IS NOT TRUE`);
  const parenthesizedNotTruePredicate = wherePredicate(parenthesizedNotTrue);
  equal(parenthesizedNotTruePredicate.sql, `(o.status = 'complete') IS NOT TRUE`, 'round-3: parenthesized IS NOT TRUE source is balanced and faithful');
  equal(analyzeNullRejection(parenthesizedNotTruePredicate, 'o').possibleTruths, ['true'], 'round-3: UNKNOWN IS NOT TRUE is TRUE');
  equal(outerJoinDemotions(parenthesizedNotTrue), [], 'round-3: IS NOT TRUE preserves null-extended rows');

  const serializedFalse = JSON.parse(JSON.stringify(parenthesizedFalse)) as QueryIR;
  equal(analyzeNullRejection(wherePredicate(serializedFalse), 'o').outcome, 'rejecting', 'round-3: balanced Boolean-test text reparses after JSON');
  equal(outerJoinDemotions(serializedFalse).length, 1, 'round-3: Boolean-test demotion survives JSON');

  const nestedBooleanNot = outerVariant(`NOT ((o.status = 'complete') IS NOT FALSE)`);
  equal(wherePredicate(nestedBooleanNot).sql, `NOT ((o.status = 'complete') IS NOT FALSE)`, 'round-3: nested NOT/Boolean-test source remains balanced');
  equal(analyzeNullRejection(wherePredicate(nestedBooleanNot), 'o').outcome, 'rejecting', 'round-3: nested NOT applies after the two-valued Boolean test');
  equal(outerJoinDemotions(nestedBooleanNot).length, 1, 'round-3: nested NOT proof demotes the LEFT JOIN');

  const nestedCaseTolerant = outerVariant(`NOT (CASE WHEN o.status = 'complete' THEN true ELSE false END)`);
  equal(analyzeNullRejection(wherePredicate(nestedCaseTolerant), 'o').outcome, 'tolerant', 'round-3: CASE consumes UNKNOWN as not-TRUE before outer NOT');
  equal(outerJoinDemotions(nestedCaseTolerant), [], 'round-3: nested CASE/NOT keeps the LEFT JOIN when the null-extended row becomes TRUE');

  const nestedCaseRejecting = outerVariant(`CASE WHEN (o.status = 'complete') IS FALSE THEN true ELSE false END`);
  equal(analyzeNullRejection(wherePredicate(nestedCaseRejecting), 'o').outcome, 'rejecting', 'round-3: CASE distinguishes UNKNOWN from FALSE inside a Boolean test');
  equal(outerJoinDemotions(nestedCaseRejecting).length, 1, 'round-3: rejecting nested CASE demotes the LEFT JOIN');

  const cachedExpression = wherePredicate(outerVariant(`(o.status = 'complete') IS FALSE`));
  cachedExpression.sql = `malformed predicate text )`;
  equal(analyzeNullRejection(cachedExpression, 'o').outcome, 'rejecting', 'round-3: in-process proof uses the already-bound AST rather than reparsing Predicate.sql');

  const partialFullJoin = bindQuery(
    `SELECT c.customer_id FROM shop.customers c FULL JOIN shop.orders o ON o.customer_id = c.customer_id WHERE c.customer_id IS NOT NULL`,
    catalog,
  );
  equal(outerJoinDemotions(partialFullJoin), [], 'nearby: rejecting only one FULL JOIN unmatched side is not falsely called an inner demotion');

  const fullyRejectedFullJoin = bindQuery(
    `SELECT c.customer_id FROM shop.customers c FULL JOIN shop.orders o ON o.customer_id = c.customer_id WHERE c.customer_id = o.customer_id`,
    catalog,
  );
  equal(outerJoinDemotions(fullyRejectedFullJoin).length, 1, 'nearby: FULL JOIN demotes only when both null-extension scenarios are rejected');

  const compositeRightJoin = bindQuery(
    `SELECT o.order_id FROM shop.customers c JOIN shop.products p ON true RIGHT JOIN shop.orders o ON o.customer_id = c.customer_id WHERE c.customer_id = 1 OR p.product_id = 1`,
    catalog,
  );
  equal(outerJoinDemotions(compositeRightJoin).length, 1, 'nearby: RIGHT JOIN substitutes its composite left input together');

  // JOIN USING creates one unqualified namespace key and suppresses the
  // duplicate only for unqualified SELECT *.
  const usingKey = bindQuery(
    `SELECT customer_id FROM shop.customers c JOIN shop.orders o USING (customer_id)`,
    catalog,
  );
  equal(usingKey.bindingErrors, [], 'adversarial: unqualified USING key is not ambiguous');
  equal(usingKey.blocks[0]!.projections[0]!.columns[0]!.column, 'customer_id', 'adversarial: merged USING key resolves');
  equal(usingKey.blocks[0]!.joins[0]!.equiKeys.length, 1, 'adversarial: USING still supplies a typed equijoin key');

  const usingStar = bindQuery(
    `SELECT * FROM shop.customers c JOIN shop.orders o USING (customer_id)`,
    catalog,
  );
  equal(usingStar.bindingErrors, [], 'adversarial: USING star expansion binds cleanly');
  equal(usingStar.blocks[0]!.projections[0]!.columns.length, 14, 'adversarial: unqualified star suppresses one duplicate USING key');
  equal(usingStar.blocks[0]!.projections[0]!.columns.filter((c) => c.column === 'customer_id').length, 1, 'adversarial: merged key appears exactly once');
  equal(usingStar.blocks[0]!.projections[0]!.columns[0]!.column, 'customer_id', 'nearby: USING key leads joined-table star order');

  const qualifiedUsingStar = bindQuery(
    `SELECT c.*, o.* FROM shop.customers c JOIN shop.orders o USING (customer_id)`,
    catalog,
  );
  equal(qualifiedUsingStar.blocks[0]!.projections.map((p) => p.columns.length), [8, 7], 'nearby: qualified stars retain each relation\'s own key');

  const leftUsing = bindQuery(
    `SELECT customer_id FROM shop.customers c LEFT JOIN shop.orders o USING (customer_id)`,
    catalog,
  );
  equal(columnNullability(leftUsing.blocks[0]!.projections[0]!.columns[0]!)?.nullable, false, 'nearby: LEFT USING merged key inherits preserved-side nullability');

  const chainedUsing = bindQuery(
    `SELECT * FROM shop.customers c JOIN shop.orders o USING (customer_id) JOIN shop.events e USING (customer_id)`,
    catalog,
  );
  equal(chainedUsing.bindingErrors, [], 'nearby: an earlier merged key is one key for a later USING join');
  equal(chainedUsing.blocks[0]!.joins.map((join) => join.equiKeys.length), [1, 1], 'nearby: chained USING clauses each retain an equijoin key');
  equal(chainedUsing.blocks[0]!.projections[0]!.columns.filter((c) => c.column === 'customer_id').length, 1, 'nearby: chained USING star still emits the merged key once');

  // A joined table is one FROM output, but it is not the entire FROM output.
  // Its merged key must compete with a same-named column from a sibling item.
  const usingWithSibling = bindQuery(
    `SELECT customer_id FROM (shop.customers c JOIN shop.orders o USING (customer_id)), shop.events e`,
    catalog,
  );
  ok(usingWithSibling.bindingErrors.some((error) => error.message.includes('customer_id') && error.message.includes('ambiguous')), 'round-3: merged USING key is ambiguous with a sibling FROM output');
  equal(usingWithSibling.blocks[0]!.projections[0]!.columns[0]!.unresolved, true, 'round-3: ambiguous USING/sibling key is not silently bound to the merged representative');
  equal(usingWithSibling.blocks[0]!.joins[0]!.equiKeys.length, 1, 'round-3: sibling ambiguity does not erase the valid USING join key');

  const usingSiblingStar = bindQuery(
    `SELECT * FROM (shop.customers c JOIN shop.orders o USING (customer_id)), shop.events e`,
    catalog,
  );
  equal(usingSiblingStar.bindingErrors, [], 'round-3: star over a USING join plus sibling binds cleanly');
  equal(usingSiblingStar.blocks[0]!.projections[0]!.columns.length, 19, 'round-3: sibling star uses the full deduplicated joined-output namespace');
  equal(usingSiblingStar.blocks[0]!.projections[0]!.columns.filter((column) => column.column === 'customer_id').map((column) => column.alias), ['c', 'e'], 'round-3: unqualified star emits the merged key and unrelated sibling key separately');

  const qualifiedUsingSibling = bindQuery(
    `SELECT c.customer_id, o.customer_id, e.customer_id, c.*, o.*, e.* FROM (shop.customers c JOIN shop.orders o USING (customer_id)), shop.events e`,
    catalog,
  );
  equal(qualifiedUsingSibling.bindingErrors, [], 'round-3: every qualified USING/sibling key remains legal');
  equal(qualifiedUsingSibling.blocks[0]!.projections.slice(0, 3).map((projection) => projection.columns[0]!.alias), ['c', 'o', 'e'], 'round-3: qualified keys retain their concrete input relations');
  equal(qualifiedUsingSibling.blocks[0]!.projections.slice(3).map((projection) => projection.columns.length), [8, 7, 5], 'round-3: qualified stars retain all input keys');

  const multipleUsingKeys = bindQuery(
    `SELECT k, x FROM (VALUES (1, 2)) a(k, x) JOIN (VALUES (1, 2)) b(k, x) USING (k, x), (VALUES (1)) c(k)`,
    catalog,
  );
  ok(multipleUsingKeys.bindingErrors.some((error) => error.message.includes('"k" is ambiguous')), 'round-3: one of several merged USING keys competes with an unrelated duplicate');
  equal(multipleUsingKeys.blocks.find((block) => block.id === 'main')!.joins[0]!.equiKeys.length, 2, 'round-3: every key in a multi-column USING clause remains an equijoin key');
  equal(multipleUsingKeys.blocks.find((block) => block.id === 'main')!.projections[1]!.columns[0]!.alias, 'a', 'round-3: the non-conflicting merged key still resolves once');

  const multipleUsingStar = bindQuery(
    `SELECT *, a.*, b.*, c.* FROM (VALUES (1, 2)) a(k, x) JOIN (VALUES (1, 2)) b(k, x) USING (k, x), (VALUES (1)) c(k)`,
    catalog,
  );
  equal(multipleUsingStar.bindingErrors, [], 'round-3: multi-key qualified and unqualified stars bind cleanly');
  equal(multipleUsingStar.blocks.find((block) => block.id === 'main')!.projections[0]!.columns.map((column) => `${column.alias}.${column.column}`), ['a.k', 'a.x', 'c.k'], 'round-3: multi-key star deduplicates joined keys but retains the sibling duplicate');
  equal(multipleUsingStar.blocks.find((block) => block.id === 'main')!.projections.slice(1).map((projection) => projection.columns.length), [2, 2, 1], 'round-3: multi-key qualified stars expose each physical input key');

  const chainedUsingWithSibling = bindQuery(
    `SELECT k FROM (VALUES (1)) a(k) JOIN (VALUES (1)) b(k) USING (k) JOIN (VALUES (1)) c(k) USING (k), (VALUES (1)) d(k)`,
    catalog,
  );
  ok(chainedUsingWithSibling.bindingErrors.some((error) => error.message.includes('"k" is ambiguous')), 'round-3: a chained merged key remains ambiguous with a later sibling output');
  // Three joins, not two: the trailing `, (VALUES (1)) d(k)` is a comma cross
  // join and is recorded as one, with no equality keys. It previously produced
  // no JoinIR at all, which is how `FROM a, b` came to be described as one row
  // per `a` row. See docs/AUDIT-2026-08-03.md P0-5.
  equal(chainedUsingWithSibling.blocks.find((block) => block.id === 'main')!.joins.map((join) => join.equiKeys.length), [1, 1, 0], 'round-3: sibling ambiguity does not break a chained USING namespace');

  // A BitmapOr belongs to one heap relation. Indexable leaves across join
  // inputs are not a scan-level sargability proof.
  const crossRelationOr = bindQuery(
    `SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id WHERE c.customer_id = 1 OR o.order_id = 1`,
    catalog,
  ).blocks[0]!.predicates.find((p) => p.clause === 'where')!;
  equal(crossRelationOr.sargable, false, 'adversarial: cross-relation OR is not scan-sargable');
  ok(crossRelationOr.sargableReason!.includes('only for one heap relation'), 'adversarial: cross-relation BitmapOr limitation is explicit');
  equal(crossRelationOr.selectivity, undefined, 'adversarial: no independence estimate is invented across join inputs');

  const sameRelationOr = bindQuery(
    `SELECT order_id FROM shop.orders o WHERE o.order_id = 1 OR o.customer_id = 1`,
    catalog,
  ).blocks[0]!.predicates[0]!;
  equal(sameRelationOr.sargable, true, 'nearby: same-relation indexable OR remains sargable');
  ok(sameRelationOr.sargableReason!.includes('same o scan'), 'nearby: BitmapOr claim names its single scan');
  ok(sameRelationOr.selectivity !== undefined, 'nearby: same-relation OR may retain a catalog-backed estimate');

  // Fan-out uses hard derived cardinality bounds rather than assuming every
  // Cartesian join multiplies.
  const scalarAggregateCross = bindQuery(
    `SELECT c.customer_id FROM shop.customers c CROSS JOIN (SELECT max(created_at) AS last_at FROM shop.orders) x`,
    catalog,
  ).blocks.find((b) => b.id === 'main')!.joins[0]!;
  equal(scalarAggregateCross.fanOut, false, 'adversarial: scalar aggregate CROSS JOIN cannot fan out');
  ok(scalarAggregateCross.fanOutReason!.includes('at most one row'), 'adversarial: scalar aggregate proof is stated');

  const limitOneCross = bindQuery(
    `SELECT c.customer_id FROM shop.customers c CROSS JOIN (SELECT order_id FROM shop.orders LIMIT 1) x`,
    catalog,
  ).blocks.find((b) => b.id === 'main')!.joins[0]!;
  equal(limitOneCross.fanOut, false, 'adversarial: LIMIT 1 derived CROSS JOIN cannot fan out');
  ok(limitOneCross.fanOutReason!.includes('LIMIT 1'), 'adversarial: LIMIT bound is the fan-out proof');

  const singleValuesCross = bindQuery(
    `SELECT c.customer_id FROM shop.customers c CROSS JOIN (VALUES (1)) x(n)`,
    catalog,
  ).blocks.find((b) => b.id === 'main')!.joins[0]!;
  equal(singleValuesCross.fanOut, false, 'nearby: one-row VALUES CROSS JOIN cannot fan out');

  const twoValuesCross = bindQuery(
    `SELECT c.customer_id FROM shop.customers c CROSS JOIN (VALUES (1), (2)) x(n)`,
    catalog,
  ).blocks.find((b) => b.id === 'main')!.joins[0]!;
  equal(twoValuesCross.fanOut, true, 'nearby: two-row VALUES CROSS JOIN still fans out');

  const groupedAggregateCross = bindQuery(
    `SELECT c.customer_id FROM shop.customers c CROSS JOIN (SELECT status, max(created_at) FROM shop.orders GROUP BY status) x`,
    catalog,
  ).blocks.find((b) => b.id === 'main')!.joins[0]!;
  equal(groupedAggregateCross.fanOut, true, 'nearby: grouped aggregate has no one-row proof');

  const noFromCross = bindQuery(
    `SELECT c.customer_id FROM shop.customers c CROSS JOIN (SELECT 1 AS n) x`,
    catalog,
  ).blocks.find((b) => b.id === 'main')!.joins[0]!;
  equal(noFromCross.fanOut, false, 'nearby: SELECT without FROM is at most one row');

  const setReturningCross = bindQuery(
    `SELECT c.customer_id FROM shop.customers c CROSS JOIN (SELECT generate_series(1, 2) AS n) x`,
    catalog,
  ).blocks.find((b) => b.id === 'main')!.joins[0]!;
  equal(setReturningCross.fanOut, true, 'nearby: possible SELECT-list SRF prevents a false one-row proof');

  // Quoted identifiers are exact, while duplicate output names are genuine
  // ambiguities in output-name resolution.
  const quotedTable = bindQuery(`SELECT * FROM shop."ORDERS"`, catalog);
  ok(quotedTable.bindingErrors.some((e) => e.severity === 'error' && e.message.includes('not in the catalog')), 'adversarial: invalid quoted table case is rejected');

  const quotedColumn = bindQuery(`SELECT o."ORDER_ID" FROM shop.orders o`, catalog);
  ok(quotedColumn.bindingErrors.some((e) => e.severity === 'error' && e.message.includes('ORDER_ID')), 'adversarial: invalid quoted column case is rejected');

  const quotedLowercase = bindQuery(`SELECT o."order_id" FROM shop.orders o`, catalog);
  equal(quotedLowercase.bindingErrors, [], 'nearby: exactly matching lowercase quoted column still binds');

  const quotedAlias = bindQuery(`SELECT "O".order_id FROM shop.orders AS "O"`, catalog);
  equal(quotedAlias.bindingErrors, [], 'nearby: quoted mixed-case relation alias binds by exact spelling');

  const duplicateOrderAlias = bindQuery(
    `SELECT o.order_id AS x, o.customer_id AS x FROM shop.orders o ORDER BY x`,
    catalog,
  );
  ok(duplicateOrderAlias.bindingErrors.some((e) => e.message.includes('ORDER BY') && e.message.includes('ambiguous')), 'adversarial: duplicate ORDER BY output alias is rejected');
  equal(duplicateOrderAlias.blocks[0]!.orderBy[0]!.column, null, 'adversarial: ambiguous output alias is not silently bound to the first projection');

  const duplicateDerivedAlias = bindQuery(
    `SELECT d.x FROM (SELECT o.order_id AS x, o.customer_id AS x FROM shop.orders o) d`,
    catalog,
  );
  ok(duplicateDerivedAlias.bindingErrors.some((e) => e.message.includes('ambiguous')), 'nearby: duplicate derived output names remain ambiguous when qualified');

  // The advertised QueryIR now carries critical facts through serialization.
  const q05RoundTrip = JSON.parse(JSON.stringify(ir('q05'))) as QueryIR;
  const q05RoundPredicate = q05RoundTrip.blocks.find((b) => b.id === 'main')!.predicates[0]!;
  equal(nestedBlockIds(q05RoundPredicate), ['sub:1'], 'adversarial: subquery block link survives JSON round-trip');
  equal(columnNullability(q05RoundTrip.blocks.find((b) => b.id === 'sub:1')!.projections[0]!.columns[0]!)?.nullable, true, 'adversarial: nullable NOT IN child output survives JSON round-trip');

  const q03RoundTrip = JSON.parse(JSON.stringify(ir('q03'))) as QueryIR;
  equal(nestedBlockIds(q03RoundTrip.blocks.find((b) => b.id === 'main')!.projections[2]!), ['sub:1'], 'nearby: scalar-projection child link survives JSON round-trip');

  const q09RoundTrip = JSON.parse(JSON.stringify(ir('q09'))) as QueryIR;
  equal(q09RoundTrip.blocks[0]!.groupByExpressions![0]!.sql, 'o.created_at::date', 'adversarial: group expression survives JSON without overloading column name');
  equal(q09RoundTrip.blocks[0]!.groupBy.every((ref) => !ref.unresolved), true, 'adversarial: valid expression lineage refs are resolved after JSON');

  const q12RoundTrip = JSON.parse(JSON.stringify(ir('q12'))) as QueryIR;
  equal(q12RoundTrip.blocks[0]!.groupByExpressions![0]!.ordinal, 1, 'nearby: GROUP BY ordinal survives JSON');
  equal(q12RoundTrip.blocks[0]!.groupByExpressions![0]!.columns[0]!.column, 'payload', 'nearby: ordinal retains its producing-expression lineage');

  const q07RoundTrip = JSON.parse(JSON.stringify(ir('q07'))) as QueryIR;
  equal(outerJoinDemotions(q07RoundTrip).length, 1, 'nearby: AST null rejection works on serialized QueryIR');

  // estimatedRows is emitted only for a complete supported conjunction.
  equal(main('q01').relations.find((r) => r.alias === 'o')!.estimatedRows, undefined, 'adversarial: q01 partial selectivity is not presented as post-filter rows');
  equal(main('q12').relations.find((r) => r.alias === 'e')!.estimatedRows, undefined, 'adversarial: q12 partial selectivity is not presented as post-filter rows');
  ok(main('q04').relations.find((r) => r.alias === 'o')!.estimatedRows! > 1_000_000, 'nearby: fully known status-only estimate remains available');
  equal(ir('q03').blocks.find((b) => b.id === 'sub:1')!.relations[0]!.estimatedRows, undefined, 'nearby: correlated equality does not inherit the full base-table estimate');
  equal(ir('q03').blocks.find((b) => b.id === 'sub:1')!.relations[0]!.localPredicates.length, 1, 'nearby: correlated equality is attached as a parameterized local predicate');

  // -------------------------------------------------------------------------
  // Fan-out must be orientation-independent.
  //
  // Round 3 rejected M1 because reordering q06's FROM items flipped every join
  // to fanOut=false with the reason "so this join cannot multiply rows", while
  // the live server returned the identical 3.0000x-inflated revenue (902,913,180
  // against a true 300,971,060). The verdict must not depend on spelling.
  // -------------------------------------------------------------------------
  const fanBind = (from: string) =>
    bindQuery(
      `SELECT c.customer_id, sum(o.total_cents) AS revenue FROM ${from} ` +
        `WHERE o.status = 'complete' GROUP BY c.customer_id`,
      catalog,
    ).blocks[0]!;
  /** Every relation this block's joins duplicate — the signal an aggregate is over-counted. */
  const multiplied = (block: QueryBlockIR) => {
    const seen = new Set<string>();
    for (const join of block.joins) for (const alias of join.multipliedRelations ?? []) seen.add(alias);
    return [...seen].sort();
  };

  const orderings: Record<string, string> = {
    'customers-first': 'shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id JOIN shop.order_items oi ON oi.order_id = o.order_id',
    'items-first': 'shop.order_items oi JOIN shop.orders o ON oi.order_id = o.order_id JOIN shop.customers c ON o.customer_id = c.customer_id',
    'orders-first': 'shop.orders o JOIN shop.order_items oi ON oi.order_id = o.order_id JOIN shop.customers c ON o.customer_id = c.customer_id',
  };
  for (const [label, from] of Object.entries(orderings)) {
    const block = fanBind(from);
    equal(block.joins.every((j) => j.fanOut), true, `fan-out: every q06 join multiplies (${label})`);
    equal(multiplied(block), ['c', 'o'], `fan-out: q06 names both multiplied relations (${label})`);
    ok(
      block.joins.every((j) => !/cannot multiply rows/.test(j.fanOutReason ?? '')),
      `fan-out: no join claims it cannot multiply rows (${label})`,
    );
  }

  // Precision guard: without order_items nothing multiplies `o`, so an aggregate
  // over o's columns must NOT be reported as over-counted. A fan-out rule that
  // fires everywhere is as useless as one that never fires.
  const safe = fanBind('shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id');
  equal(multiplied(safe), ['c'], 'fan-out: one-to-many alone multiplies only the left relation');
  equal(safe.joins[0]!.fanOutSide, 'left', 'fan-out: unique right side multiplies the left input');

  // The mirror image in isolation: unique right, non-unique left.
  const mirror = bindQuery(
    'SELECT * FROM shop.order_items oi JOIN shop.orders o ON oi.order_id = o.order_id',
    catalog,
  ).blocks[0]!;
  equal(mirror.joins[0]!.fanOut, true, 'fan-out: non-unique left repeats the right side');
  equal(mirror.joins[0]!.fanOutSide, 'right', 'fan-out: mirror-image fan-out is labelled right');
  equal(mirror.joins[0]!.multipliedRelations, ['o'], 'fan-out: the repeated relation is named');

  // Both sides unique on the key — the genuinely safe join must stay silent.
  const oneToOne = bindQuery(
    'SELECT * FROM shop.orders o JOIN shop.customers c ON c.customer_id = o.order_id',
    catalog,
  ).blocks[0]!;
  equal(oneToOne.joins[0]!.fanOut, false, 'fan-out: unique-on-both-sides join does not fan out');
  equal(oneToOne.joins[0]!.multipliedRelations, [], 'fan-out: nothing is multiplied when both sides are unique');

  // A USING chain whose left input stops being unique after the first join.
  const usingChain = bindQuery(
    'SELECT * FROM shop.customers c JOIN shop.orders o USING (customer_id) JOIN shop.order_items oi ON oi.order_id = o.order_id',
    catalog,
  ).blocks[0]!;
  equal(usingChain.joins.every((j) => j.fanOut), true, 'fan-out: USING chain multiplies at both steps');
  ok(multiplied(usingChain).includes('o'), 'fan-out: USING chain records orders as multiplied');


  // -------------------------------------------------------------------------
  // Multiplicity state must be BLOCK-SCOPED.
  //
  // The first version of the fan-out fix kept one multiplicity set per binder.
  // It passed every assertion above and was still wrong: state leaked between
  // independent blocks, so two identical side-by-side derived tables produced
  // different verdicts, and a CTE that multiplied `c` made an unrelated 1:1 join
  // in the main block report a fan-out it does not have. That is the same
  // context-dependence the fix exists to remove, just at a different scope.
  // -------------------------------------------------------------------------
  const twinBlocks = bindQuery(
    'SELECT * FROM (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) d1, ' +
      '(SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) d2',
    catalog,
  );
  const twinA = twinBlocks.blocks.find((b) => b.id === 'sub:1')!;
  const twinB = twinBlocks.blocks.find((b) => b.id === 'sub:2')!;
  equal(
    [twinA.joins[0]!.fanOut, twinA.joins[0]!.fanOutSide, multiplied(twinA)],
    [twinB.joins[0]!.fanOut, twinB.joins[0]!.fanOutSide, multiplied(twinB)],
    'fan-out: identical sibling blocks reach identical verdicts',
  );

  // A CTE that multiplies `c` must not contaminate an unrelated 1:1 join later.
  const oneToOneSql = 'SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.order_id = c.customer_id';
  const withNoisyCte = bindQuery(
    'WITH x AS (SELECT c.customer_id FROM shop.customers c JOIN shop.orders o ON o.customer_id = c.customer_id) ' +
      oneToOneSql,
    catalog,
  );
  const contaminated = withNoisyCte.blocks.find((b) => b.id === 'main')!;
  const control = bindQuery(oneToOneSql, catalog).blocks[0]!;
  equal(
    [contaminated.joins[0]!.fanOut, contaminated.joins[0]!.fanOutSide],
    [control.joins[0]!.fanOut, control.joins[0]!.fanOutSide],
    'fan-out: a multiplying CTE does not contaminate a later 1:1 join',
  );
  equal(control.joins[0]!.fanOut, false, 'fan-out: the control 1:1 join genuinely does not fan out');

  // Old-style comma joins put the join condition in WHERE and so produced no
  // JoinIR at all — q06 written that way reported NO fan-out, losing the
  // correctness signal to a mere change of spelling.
  const commaQ06 = bindQuery(
    'SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c, shop.orders o, shop.order_items oi ' +
      'WHERE o.customer_id = c.customer_id AND oi.order_id = o.order_id GROUP BY c.customer_id',
    catalog,
  ).blocks[0]!;
  equal(commaQ06.joins.length, 2, 'comma join: both implied joins are recovered');
  equal(multiplied(commaQ06), ['c', 'o'], 'comma join: q06 in comma form reports the same multiplicity as ANSI form');

  // A comma relation with no equating predicate is a real cross join, and is
  // recorded as one. This previously asserted zero joins, on the reasoning that
  // synthesizing one would be inventing a join that is not there. But the join
  // *is* there — it is what the comma means — and dropping it left the block
  // with no JoinIR, so `FROM customers c, products p` was explained as "one row
  // per qualifying customer row" for a Cartesian product of ten billion rows.
  // Recording a cross join reports the SQL as written. See
  // docs/AUDIT-2026-08-03.md P0-5.
  const commaCross = bindQuery('SELECT * FROM shop.customers c, shop.products p', catalog).blocks[0]!;
  equal(commaCross.joins.length, 1, 'comma join: an unequated comma relation is recorded as the cross join it is');
  equal(commaCross.joins[0]!.type, 'cross', 'comma join: and it is typed as a cross join');
  equal(commaCross.joins[0]!.fanOut, true, 'comma join: a Cartesian product multiplies unconditionally');

  // A correlated LATERAL carries its join condition inside its own block, so the
  // outer ON reads `ON true` and only *looks* keyless. Treating it as keyless
  // claimed the lateral's own rows were multiplied, which over-reports: the
  // server confirms the aggregate is exact. Live proof in
  // reports/round4/probe-lateral.ts (sums compared against the server, not
  // reasoned about here).
  const lateralCorrelated = bindQuery(
    'SELECT c.customer_id, sum(t.total_cents) FROM shop.customers c ' +
      'JOIN LATERAL (SELECT o.total_cents FROM shop.orders o WHERE o.customer_id = c.customer_id) t ON true ' +
      'GROUP BY c.customer_id',
    catalog,
  ).blocks.find((b) => b.id === 'main')!;
  const lateralControl = bindQuery(
    'SELECT c.customer_id, sum(o.total_cents) FROM shop.customers c ' +
      'JOIN shop.orders o ON o.customer_id = c.customer_id GROUP BY c.customer_id',
    catalog,
  ).blocks[0]!;
  equal(
    [lateralCorrelated.joins[0]!.fanOutSide, multiplied(lateralCorrelated)],
    [lateralControl.joins[0]!.fanOutSide, multiplied(lateralControl)],
    'lateral: a correlated LATERAL reaches the same verdict as the equivalent plain join',
  );
  equal(multiplied(lateralCorrelated), ['c'], 'lateral: the lateral output is not claimed multiplied when the outer side is unique on the correlation key');

  // The mirror image: the lateral yields at most one row per outer row, but the
  // outer side is not unique on the key, so each lateral row IS re-derived.
  // Server-verified at 10.0000x inflation (probe-lateral.ts case B).
  const lateralMirror = bindQuery(
    'SELECT o.order_id, t.customer_id FROM shop.orders o ' +
      'JOIN LATERAL (SELECT c.customer_id FROM shop.customers c WHERE c.customer_id = o.customer_id) t ON true',
    catalog,
  ).blocks.find((b) => b.id === 'main')!;
  equal(lateralMirror.joins[0]!.fanOutSide, 'right', 'lateral: a unique-inner correlated lateral multiplies only its own rows');
  equal(multiplied(lateralMirror), ['t'], 'lateral: the mirror-image lateral fan-out is detected');

  // Precision guard. An UNcorrelated lateral really is keyless and must keep the
  // pessimistic verdict — the fix must not fire on the mere presence of LATERAL.
  const lateralUncorrelated = bindQuery(
    "SELECT c.customer_id, t.total_cents FROM shop.customers c " +
      "JOIN LATERAL (SELECT o.total_cents FROM shop.orders o WHERE o.status = 'complete' LIMIT 3) t ON true",
    catalog,
  ).blocks.find((b) => b.id === 'main')!;
  equal(lateralUncorrelated.joins[0]!.fanOutSide, 'both', 'lateral: an uncorrelated lateral stays pessimistic');
  equal(multiplied(lateralUncorrelated), ['c', 't'], 'lateral: an uncorrelated lateral still reports both sides multiplied');

  // A negated correlation is not an equi-key and must not be mistaken for one.
  const lateralNegated = bindQuery(
    'SELECT c.customer_id, t.total_cents FROM shop.customers c ' +
      'JOIN LATERAL (SELECT o.total_cents FROM shop.orders o WHERE o.customer_id <> c.customer_id) t ON true',
    catalog,
  ).blocks.find((b) => b.id === 'main')!;
  equal(lateralNegated.joins[0]!.fanOutSide, 'both', 'lateral: an inequality correlation is not treated as a join key');

  return assertions;
}

function printIr(id: string, ir: QueryIR): void {
  console.log(`\n=== ${id} | ${ir.blocks.length} block(s) | ${ir.bindingErrors.length} binding error(s) ===`);
  for (const block of ir.blocks) {
    console.log(`\n[${block.id}] ${block.kind}${block.correlated ? ' CORRELATED' : ''}`);
    for (const relation of block.relations) {
      console.log(
        `  relation ${relation.alias} -> ${relation.kind}:${relation.source}` +
          `${relation.estimatedRows === undefined ? '' : ` (~${relation.estimatedRows} rows)`}`,
      );
      for (const predicate of relation.localPredicates) {
        console.log(`    local ${predicate.clause}: ${predicate.sql}`);
      }
    }
    for (const join of block.joins) {
      console.log(
        `  join ${join.leftRelation} ${join.type} ${join.rightRelation} fanOut=${join.fanOut}` +
          ` keys=${join.equiKeys.map((k) => `${ref(k.left)}=${ref(k.right)}`).join(', ') || '(none)'}`,
      );
      console.log(`    ${join.fanOutReason}`);
    }
    for (const predicate of block.predicates) {
      const nested = nestedBlockIds(predicate);
      console.log(
        `  predicate ${predicate.clause}/${predicate.kind}${predicate.negated ? '/negated' : ''}` +
          ` sargable=${predicate.sargable}: ${predicate.sql}` +
          `${predicate.selectivity === undefined ? '' : ` [sel=${predicate.selectivity}]`}` +
          `${nested.length ? ` -> ${nested.join(', ')}` : ''}`,
      );
      console.log(`    ${predicate.sargableReason ?? '(no reason)'}`);
    }
    console.log(
      `  projections: ${block.projections
        .map((p) => `${p.sql}${p.alias ? ` AS ${p.alias}` : ''} [${p.columns.map(ref).join(', ')}]`)
        .join(' | ') || '(none)'}`,
    );
    console.log(
      `  group: ${
        block.groupByExpressions?.length
          ? block.groupByExpressions
              .map((g) => `${g.sql}${g.ordinal === undefined ? '' : ` (ordinal ${g.ordinal})`} [${g.columns.map(ref).join(', ')}]`)
              .join(', ')
          : block.groupBy.map(ref).join(', ') || '(none)'
      }`,
    );
    console.log(
      `  order: ${block.orderBy
        .map((o) => `${o.sql} ${o.direction}${o.nulls ? ` NULLS ${o.nulls}` : ''} -> ${o.column ? ref(o.column) : '(expression/alias)'}`)
        .join(', ') || '(none)'}`,
    );
    console.log(`  aggregates: ${block.aggregates.map((a) => a.sql).join(', ') || '(none)'}`);
    console.log(`  windows: ${block.windowFunctions.map((w) => w.sql).join(', ') || '(none)'}`);
    if (block.correlationRefs?.length) console.log(`  correlation refs: ${block.correlationRefs.map(ref).join(', ')}`);
  }
  for (const demotion of outerJoinDemotions(ir)) console.log(`  OUTER JOIN DEMOTION: ${demotion.reason}`);
  for (const error of ir.bindingErrors) {
    console.log(`  ${error.severity.toUpperCase()}: ${error.message}${error.sqlFragment ? ` [${error.sqlFragment}]` : ''}`);
  }
}

function ref(column: ResolvedColumnRef): string {
  return `${column.alias ?? column.table ?? '?'}.${column.column}${column.unresolved ? '?' : ''}`;
}
