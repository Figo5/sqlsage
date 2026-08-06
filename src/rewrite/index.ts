/** M6 — conservative structural rewrites for supported PostgreSQL SELECT shapes. */

import { qualifiedTable, quoteIdentifier } from '../advice/definitions.ts';
import { bareNullEquality } from '../antipatterns/index.ts';
import { findTable } from '../catalog.ts';
import { nestedBlockIds } from '../ir/index.ts';
import { recommendIndexes } from '../indexes/index.ts';
import type {
  Catalog,
  Finding,
  IndexRecommendation,
  Predicate,
  QueryBlockIR,
  QueryIR,
  ResolvedColumnRef,
  Rewrite,
} from '../types.ts';

interface RenderOptions {
  projectionOverrides?: Map<number, string>;
  relationOverrides?: Map<string, string>;
  whereOverrides?: Map<string, string>;
  extraJoins?: string[];
  extraWhere?: string[];
  omitOffset?: boolean;
  distinct?: boolean;
}

/** Propose only rewrites whose supported structural preconditions can be proven. */
export function proposeRewrites(
  ir: QueryIR,
  catalog: Catalog,
  findings: Finding[],
): Rewrite[] {
  const root = ir.blocks.find((block) => block.id === ir.rootBlockId);
  if (!root || ir.statementType !== 'select' || ir.bindingErrors.some((error) => error.severity === 'error')) return [];
  const indexes = recommendIndexes(ir, catalog, findings);
  const rewrites: Rewrite[] = [];

  if (hasFinding(findings, 'non-sargable-function-on-column')) {
    const rewrite = rewriteMonthRange(ir, catalog, root, findings, indexes);
    if (rewrite) rewrites.push(rewrite);
  }
  if (hasFinding(findings, 'repeated-correlated-aggregate-scans')) {
    const rewrite = rewriteRepeatedAggregates(ir, catalog, root);
    if (rewrite) rewrites.push(rewrite);
  }
  if (hasFinding(findings, 'deep-offset-pagination')) {
    const rewrite = rewriteDeepOffset(ir, catalog, root, indexes);
    if (rewrite) rewrites.push(rewrite);
  }
  if (hasFinding(findings, 'not-in-nullable-subquery')) {
    const rewrite = rewriteNullableNotIn(ir, catalog, root, indexes);
    if (rewrite) rewrites.push(rewrite);
  }
  if (hasFinding(findings, 'null-literal-equality')) {
    const rewrite = rewriteNullLiteralEquality(catalog, root);
    if (rewrite) rewrites.push(rewrite);
  }
  if (hasFinding(findings, 'aggregate-over-one-to-many-fanout')) {
    const rewrite = rewriteAggregateFanOut(catalog, root);
    if (rewrite) rewrites.push(rewrite);
  }
  // A proven outer-join demotion is intentionally not rewritten: SQL cannot
  // choose whether to preserve unmatched rows or declare inner semantics.
  if (hasFinding(findings, 'distinct-collapses-existence-fanout')) {
    const rewrite = rewriteDistinctExistence(catalog, root, indexes);
    if (rewrite) rewrites.push(rewrite);
  }
  if (hasFinding(findings, 'non-sargable-cast-on-column')) {
    const rewrite = rewriteDateCastRange(ir, catalog, root, findings, indexes);
    if (rewrite) rewrites.push(rewrite);
  }
  if (hasFinding(findings, 'full-cardinality-correlated-aggregate')) {
    const rewrite = rewriteTopPerGroup(ir, catalog, root, indexes);
    if (rewrite) rewrites.push(rewrite);
  }
  // Grouping-key HAVING pushdown and JSON/count-distinct observations do not
  // warrant automatic SQL changes in this MVP.

  return rewrites.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Supported transformations
// ---------------------------------------------------------------------------

function rewriteMonthRange(
  _ir: QueryIR,
  catalog: Catalog,
  block: QueryBlockIR,
  findings: Finding[],
  indexes: IndexRecommendation[],
): Rewrite | undefined {
  const finding = firstFinding(findings, 'non-sargable-function-on-column');
  const predicate = predicateForFinding(block, finding);
  const ref = predicate && singleColumn(predicate);
  if (!predicate || !ref || !/timestamp with time zone/i.test(ref.dataType ?? '')) return undefined;
  const match = /date_trunc\s*\(\s*'month'\s*,[\s\S]+?\)\s*=\s*TIMESTAMPTZ\s*'(\d{4})-(\d{2})-01(?:\s+00:00(?::00(?:\.0+)?)?)?'/i.exec(predicate.sql);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!validMonth(year, month)) return undefined;
  const next = month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
  const start = `${year}-${pad(month)}-01`;
  const column = sqlRef(ref);
  const replacement = `${column} >= TIMESTAMPTZ '${start}' AND ${column} < TIMESTAMPTZ '${next}'`;
  const sql = renderSelect(block, catalog, {
    whereOverrides: new Map([[sqlKey(predicate.sql), replacement]]),
  });
  if (!sql) return undefined;
  const required = findIndex(indexes, ref.table, [ref.column], 'raw range');
  if (!required) return undefined; // Never separate this raw-range rewrite from its coupled index advice.
  return {
    id: 'rewrite-month-function-to-half-open-range',
    title: 'Filter the raw timestamp with a half-open month range',
    sql,
    rationale:
      `The original function hides ${column} from a normal B-tree. Equality keys can now lead the coupled index and ${ref.column} becomes its first bounded range key.`,
    equivalence: 'exact',
    equivalenceNotes:
      `For an un-offset TIMESTAMPTZ month-start literal, both date_trunc and these two boundaries use the same session TimeZone and select the same local calendar month. If the business means a fixed zone such as UTC, pin that zone in both boundaries explicitly.`,
    expectedSpeedup:
      'Predicted/unverified: the rewrite unlocks a bounded index path; no runtime ratio is claimed without an EXPLAIN ANALYZE comparison. The coupled index has no useful effect on the wrapped predicate alone.',
    requiresIndexes: [required.id],
    priority: 1,
  };
}

function rewriteRepeatedAggregates(
  ir: QueryIR,
  catalog: Catalog,
  root: QueryBlockIR,
): Rewrite | undefined {
  if (root.relations.length !== 1 || root.joins.length || root.relations[0]!.kind !== 'table') return undefined;
  const children = ir.blocks.filter((block) => block.correlated && block.aggregates.length === 1);
  if (children.length < 2) return undefined;
  const uses = children.map((child) => ({ child, usage: projectionUsingBlock(root, child.id) }));
  if (uses.some(({ usage }) => !usage?.projection.alias)) return undefined;
  const source = children[0]!.relations[0]?.source;
  const commonOuterRefs = correlationSignature(children[0]!);
  if (!source || children.some((child) =>
    child.relations.length !== 1 || child.relations[0]!.kind !== 'table' || child.relations[0]!.source !== source ||
    child.joins.length > 0 || child.groupBy.length > 0 || child.windowFunctions.length > 0 ||
    child.limit !== undefined || child.offset !== undefined || correlationSignature(child) !== commonOuterRefs
  )) return undefined;

  const innerAlias = children[0]!.relations[0]!.alias;
  const normalizedFilters = children.map((child) =>
    child.predicates.filter((predicate) => predicate.clause === 'where')
      .map((predicate) => normalizeAlias(predicate.sql, child.relations[0]!.alias, innerAlias))
      .sort().join(' AND '),
  );
  if (new Set(normalizedFilters).size !== 1 || !normalizedFilters[0]) return undefined;

  const lateralAlias = unusedAlias(root, 'sqlsage_agg');
  const aggregateSql = uses.map(({ child, usage }) => {
    const expression = normalizeAlias(child.aggregates[0]!.sql, child.relations[0]!.alias, innerAlias);
    return `${expression} AS ${quoteIdentifier(usage!.projection.alias!)}`;
  }).join(', ');
  const lateral =
    `LEFT JOIN LATERAL (SELECT ${aggregateSql} FROM ${qualifiedTable(catalog, source)} AS ${quoteIdentifier(innerAlias)} ` +
    `WHERE ${normalizedFilters[0]}) AS ${quoteIdentifier(lateralAlias)} ON TRUE`;
  const overrides = new Map<number, string>();
  for (const { usage } of uses) {
    overrides.set(usage!.index, `${quoteIdentifier(lateralAlias)}.${quoteIdentifier(usage!.projection.alias!)}`);
  }
  const sql = renderSelect(root, catalog, { projectionOverrides: overrides, extraJoins: [lateral] });
  if (!sql) return undefined;
  return {
    id: 'rewrite-repeated-correlated-aggregates-to-lateral',
    title: 'Compute correlated aggregates in one LATERAL probe',
    sql,
    rationale:
      `The two scalar subqueries use the same source, correlation key, and filter. One aggregate-only LATERAL body computes all values in a single per-outer-row probe rather than repeating it.`,
    equivalence: 'exact',
    equivalenceNotes:
      'The LATERAL body has aggregate output and no GROUP BY, so it always returns exactly one row: COUNT remains 0 and MAX/MIN remain NULL when no inner row matches. The outer row is therefore preserved exactly.',
    expectedSpeedup:
      'Predicted/unverified: halves repeated inner probes, but the current outer input may already be selective and indexed. Treat the rewrite as maintainability plus a possible small win until measured.',
    priority: 3,
  };
}

function rewriteDeepOffset(
  _ir: QueryIR,
  catalog: Catalog,
  block: QueryBlockIR,
  indexes: IndexRecommendation[],
): Rewrite | undefined {
  if (block.offset === undefined || block.orderBy.length < 2 || block.orderBy.some((order) => !order.column)) return undefined;
  const refs = block.orderBy.map((order) => order.column!);
  const alias = refs[0]!.alias;
  const table = refs[0]!.table;
  const directions = new Set(block.orderBy.map((order) => order.direction));
  if (!alias || !table || directions.size !== 1 || refs.some((ref) => ref.alias !== alias || ref.table !== table)) return undefined;
  if (!orderingIsUnique(catalog, table, refs.map((ref) => ref.column))) return undefined;
  const comparison = block.orderBy[0]!.direction === 'desc' ? '<' : '>';
  const tuple = `(${refs.map(sqlRef).join(', ')}) ${comparison} (${refs.map((_, index) => `$${index + 1}`).join(', ')})`;
  const sql = renderSelect(block, catalog, { extraWhere: [tuple], omitOffset: true });
  if (!sql) return undefined;
  const required = findIndex(indexes, table, refs.map((ref) => ref.column), 'cursor order');
  if (!required) return undefined;
  return {
    id: 'rewrite-deep-offset-to-row-value-keyset',
    title: 'Replace deep OFFSET with a row-value cursor',
    sql,
    rationale:
      `The complete (${refs.map((ref) => ref.column).join(', ')}) tuple matches the deterministic ORDER BY and lets PostgreSQL seek after the previous page instead of producing and discarding ${block.offset.toLocaleString('en-US')} rows.`,
    equivalence: 'conditional',
    equivalenceNotes:
      `This returns the same next page only when $1..$${refs.length} are the final ordering tuple from the preceding page under a compatible snapshot. It cannot jump directly to an arbitrary page number, so the API must carry a cursor.`,
    expectedSpeedup:
      'Predicted/unverified: changes work from growing with page depth to growing primarily with page size when the coupled ordering index is used.',
    requiresIndexes: [required.id],
    priority: 1,
  };
}

function rewriteNullableNotIn(
  ir: QueryIR,
  catalog: Catalog,
  root: QueryBlockIR,
  indexes: IndexRecommendation[],
): Rewrite | undefined {
  const predicate = root.predicates.find((candidate) =>
    candidate.kind === 'subquery' && candidate.negated && /\bNOT\s+IN\s*\(/i.test(candidate.sql),
  );
  const child = predicate && nestedBlockIds(predicate).map((id) => ir.blocks.find((block) => block.id === id)).find(Boolean);
  const output = child?.projections[0]?.columns[0];
  const outer = predicate?.columns[0];
  const relation = child?.relations.find((candidate) => candidate.alias === output?.alias);
  if (!predicate || !child || child.projections.length !== 1 || !output?.nullable || !outer || !output.alias || !relation?.source) return undefined;
  if (child.relations.length !== 1 || child.joins.length || child.groupBy.length || child.aggregates.length) return undefined;
  const filters = child.predicates.filter((candidate) => candidate.clause === 'where');
  if (filters.some((filter) => filter.columns.some((column) => column.alias !== output.alias))) return undefined;
  const where = [...filters.map((filter) => filter.sql), `${sqlRef(output)} = ${sqlRef(outer)}`].join(' AND ');
  const replacement = `NOT EXISTS (SELECT 1 FROM ${qualifiedTable(catalog, relation.source)} AS ${quoteIdentifier(output.alias)} WHERE ${where})`;
  const sql = renderSelect(root, catalog, { whereOverrides: new Map([[sqlKey(predicate.sql), replacement]]) });
  if (!sql) return undefined;
  const required = findIndex(indexes, relation.source, [output.column], 'anti-join');
  return {
    id: 'rewrite-nullable-not-in-to-not-exists',
    title: 'Use NULL-safe NOT EXISTS anti-membership',
    sql,
    rationale:
      'The original NOT IN can become UNKNOWN for every otherwise-unmatched row after one NULL. Correlated NOT EXISTS tests actual equality and is not poisoned by unrelated NULL subquery outputs.',
    equivalence: 'different-semantics',
    equivalenceNotes:
      'This intentionally repairs the original wrong-result behavior when the subquery can emit NULL; it can return outer rows that NOT IN incorrectly suppresses. Review that corrected population as a correctness change.',
    expectedSpeedup:
      'No comparable speedup is claimed because the result population intentionally changes. The optional partial index can support the corrected anti-join after semantics are fixed.',
    requiresIndexes: required ? [required.id] : undefined,
    priority: 1,
  };
}

/**
 * Rewrite `col = NULL` → `col IS NULL` and `col <> NULL` / `col != NULL` →
 * `col IS NOT NULL`. The original is never true (UNKNOWN), so this is an
 * intentional result-changing repair, not an equivalence rewrite — the whole
 * point is that the rewritten query returns rows the original suppressed.
 */
function rewriteNullLiteralEquality(catalog: Catalog, block: QueryBlockIR): Rewrite | undefined {
  // The detector keys the finding's evidence.sqlFragment on the predicate sql,
  // so find the predicate by the same shape it used: an equality predicate that
  // is a direct column-vs-NULL comparison.
  const predicate = block.predicates.find((candidate) =>
    candidate.kind === 'equality' && bareNullEquality(candidate.sql) !== undefined,
  );
  if (!predicate) return undefined;
  const ref = singleColumn(predicate);
  if (!ref) return undefined;
  const column = sqlRef(ref);
  const isNegated = bareNullEquality(predicate.sql) !== '=';
  const replacement = `${column} IS ${isNegated ? 'NOT ' : ''}NULL`;
  const sql = renderSelect(block, catalog, { whereOverrides: new Map([[sqlKey(predicate.sql), replacement]]) });
  if (!sql) return undefined;
  return {
    id: 'rewrite-null-literal-to-is-null',
    title: isNegated ? 'Test for non-NULL rows with IS NOT NULL' : 'Test for NULL with IS NULL',
    sql,
    rationale:
      `${predicate.sql} compares with the NULL keyword, which is never true. ` +
      `IS ${isNegated ? 'NOT ' : ''}NULL is the null-aware form that actually selects the intended rows.`,
    equivalence: 'different-semantics',
    equivalenceNotes:
      'The original predicate is never true (every comparison with NULL is UNKNOWN), so it returns no rows. The rewrite returns rows — that is the repair. Review the now-populated result as a correctness change.',
    expectedSpeedup:
      'No speedup is claimed because the result population intentionally changes; the rewrite corrects a silent wrong-result bug rather than optimizing a correct one.',
    priority: 1,
  };
}

function rewriteAggregateFanOut(catalog: Catalog, block: QueryBlockIR): Rewrite | undefined {
  const affected = block.aggregates.flatMap((aggregate) => {
    if (aggregate.distinct || !['sum', 'avg', 'count'].includes(aggregate.func.toLowerCase())) return [];
    const projectionIndex = block.projections.findIndex((projection) => sameSql(projection.sql, aggregate.sql));
    const projection = block.projections[projectionIndex];
    if (!projection?.columns.length) return [];
    const aliases = unique(projection.columns.map((column) => column.alias).filter((alias): alias is string => !!alias));
    const culprit = block.joins.find((join) => aliases.some((alias) => join.multipliedRelations?.includes(alias)));
    return culprit ? [{ aggregate, projectionIndex, aliases, culprit }] : [];
  });
  if (!affected.length) return undefined;
  const culprit = affected[0]!.culprit;
  if (affected.some((item) => item.culprit !== culprit)) return undefined;
  const relation = block.relations.find((candidate) => candidate.alias === culprit.rightRelation);
  if (!relation || relation.kind !== 'table' || block.relations.at(-1)?.alias !== relation.alias) return undefined;
  if (culprit.equiKeys.length !== 1 || culprit.residualPredicates.length) return undefined;
  const keyPair = culprit.equiKeys[0]!;
  const rightKey = keyPair.left.alias === relation.alias ? keyPair.left : keyPair.right.alias === relation.alias ? keyPair.right : undefined;
  if (!rightKey) return undefined;
  const unsafeReferences = [
    ...block.predicates.filter((predicate) => predicate.clause === 'where').flatMap((predicate) => predicate.columns),
    ...block.projections.flatMap((projection) => projection.columns),
    ...block.groupBy,
    ...block.orderBy.flatMap((order) => order.column ? [order.column] : []),
  ].filter((ref) => ref.alias === relation.alias);
  if (unsafeReferences.length) return undefined;

  const sourceAlias = unusedAlias(block, `${relation.alias}_src`);
  const derived =
    `(SELECT ${quoteIdentifier(sourceAlias)}.${quoteIdentifier(rightKey.column)} AS ${quoteIdentifier(rightKey.column)}, ` +
    `count(*) AS ${quoteIdentifier('sqlsage_row_count')} FROM ${qualifiedTable(catalog, relation.source)} AS ${quoteIdentifier(sourceAlias)} ` +
    `GROUP BY ${quoteIdentifier(sourceAlias)}.${quoteIdentifier(rightKey.column)}) AS ${quoteIdentifier(relation.alias)}`;
  const relationOverrides = new Map([[relation.alias, derived]]);
  const projectionOverrides = new Map<number, string>();
  for (let index = 0; index < block.projections.length; index++) {
    const projection = block.projections[index]!;
    if (/^count\s*\(\s*\*\s*\)$/i.test(projection.sql)) {
      projectionOverrides.set(index, `sum(${quoteIdentifier(relation.alias)}.${quoteIdentifier('sqlsage_row_count')})::bigint`);
    }
  }
  const sql = renderSelect(block, catalog, { relationOverrides, projectionOverrides });
  if (!sql) return undefined;
  return {
    id: 'rewrite-fanout-to-order-grain',
    title: 'Reduce the many-side to one row per join key before aggregation',
    sql,
    rationale:
      `The derived relation preserves the many-side row count per ${rightKey.column} but prevents it from duplicating earlier-grain measures. SUM/AVG values over ${joinWords(affected.flatMap((item) => item.aliases))} are then computed once per natural row.`,
    equivalence: 'different-semantics',
    equivalenceNotes:
      'This intentionally changes duplicate-sensitive aggregates that the original fan-out over-counted. The rewritten summed row_count preserves the original joined-row COUNT(*), while earlier-grain SUM/AVG values are corrected.',
    expectedSpeedup:
      'Correctness comes first. Pre-aggregation may reduce downstream group/sort rows, but no runtime improvement is claimed without plan evidence.',
    priority: 1,
  };
}

function rewriteDistinctExistence(
  catalog: Catalog,
  block: QueryBlockIR,
  indexes: IndexRecommendation[],
): Rewrite | undefined {
  if (!block.distinct || block.groupBy.length || block.aggregates.length || block.having.length) return undefined;
  const projectedAliases = unique(block.projections.flatMap((projection) => projection.columns)
    .map((column) => column.alias).filter((alias): alias is string => !!alias));
  if (projectedAliases.length !== 1) return undefined;
  const driverAlias = projectedAliases[0]!;
  const driver = block.relations.find((relation) => relation.alias === driverAlias);
  if (!driver || driver.kind !== 'table' || !projectedKeyIsUnique(catalog, block, driverAlias, driver.source)) return undefined;
  if (block.relations.some((relation) => relation.kind !== 'table') || block.joins.some((join) => join.type !== 'inner')) return undefined;
  const driverJoin = block.joins.find((join) =>
    join.equiKeys.some((key) => key.left.alias === driverAlias || key.right.alias === driverAlias),
  );
  if (!driverJoin) return undefined;
  const innerRelations = block.relations.filter((relation) => relation.alias !== driverAlias);
  if (!innerRelations.length) return undefined;
  const firstInner = innerRelations[0]!;
  const innerJoinSql: string[] = [];
  for (const relation of innerRelations.slice(1)) {
    const join = block.joins.find((candidate) => candidate.rightRelation === relation.alias);
    if (!join || join === driverJoin) return undefined;
    innerJoinSql.push(`JOIN ${renderRelation(catalog, relation)} ON ${joinCondition(join)}`);
  }
  const outerPredicates = block.predicates.filter((predicate) =>
    predicate.clause === 'where' && predicate.columns.every((column) => column.alias === driverAlias),
  );
  const innerPredicates = block.predicates.filter((predicate) =>
    predicate.clause === 'where' && !outerPredicates.includes(predicate),
  );
  const existsWhere = [joinCondition(driverJoin), ...innerPredicates.map((predicate) => predicate.sql)].filter(Boolean).join(' AND ');
  if (!existsWhere) return undefined;
  const select = block.projections.map((projection) => renderProjection(projection)).join(', ');
  const outerWhere = [...outerPredicates.map((predicate) => predicate.sql),
    `EXISTS (SELECT 1 FROM ${renderRelation(catalog, firstInner)} ${innerJoinSql.join(' ')} WHERE ${existsWhere})`,
  ].join(' AND ');
  const order = renderOrderLimit(block, false);
  const sql = `SELECT ${select}\nFROM ${renderRelation(catalog, driver)}\nWHERE ${outerWhere}${order};`;
  const required = indexes.find((index) => index.priority === 1 && innerRelations.some((relation) => relation.source === index.table));
  return {
    id: 'rewrite-distinct-fanout-to-exists',
    title: 'Express joined-side filtering as EXISTS',
    sql,
    rationale:
      'Only columns from one key-proven driver relation are returned. EXISTS states that joined-side rows are a membership test and avoids materializing multiple matching paths only to remove them with DISTINCT.',
    equivalence: 'exact',
    equivalenceNotes:
      `The projected columns include a unique key of ${driver.source}, so DISTINCT cannot collapse two different driver rows. The EXISTS form therefore preserves exactly one output row for every driver row with at least one matching path.`,
    expectedSpeedup:
      'Predicted/unverified: removes duplicate generation/deduplication. The coupled bridge index is needed for a selective inner path; EXISTS alone does not guarantee an early-stop plan.',
    requiresIndexes: required ? [required.id] : undefined,
    priority: 2,
  };
}

function rewriteDateCastRange(
  _ir: QueryIR,
  catalog: Catalog,
  block: QueryBlockIR,
  findings: Finding[],
  indexes: IndexRecommendation[],
): Rewrite | undefined {
  const finding = firstFinding(findings, 'non-sargable-cast-on-column');
  const predicate = predicateForFinding(block, finding);
  const ref = predicate && singleColumn(predicate);
  if (!predicate || !ref || !/timestamp(?: with(?:out)? time zone)?/i.test(ref.dataType ?? '')) return undefined;
  const match = /::\s*date\s+BETWEEN\s+DATE\s*'(\d{4}-\d{2}-\d{2})'\s+AND\s+DATE\s*'(\d{4}-\d{2}-\d{2})'/i.exec(predicate.sql);
  if (!match) return undefined;
  const start = parseIsoDate(match[1]!);
  const end = parseIsoDate(match[2]!);
  if (!start || !end || start.valueOf() > end.valueOf()) return undefined;
  const next = new Date(end.valueOf() + 86_400_000);
  const literalType = /with time zone/i.test(ref.dataType ?? '') ? 'TIMESTAMPTZ' : 'TIMESTAMP';
  const column = sqlRef(ref);
  const replacement = `${column} >= ${literalType} '${isoDate(start)}' AND ${column} < ${literalType} '${isoDate(next)}'`;
  const sql = renderSelect(block, catalog, { whereOverrides: new Map([[sqlKey(predicate.sql), replacement]]) });
  if (!sql) return undefined;
  const required = findIndex(indexes, ref.table, [ref.column], 'raw range');
  return {
    id: 'rewrite-date-cast-to-half-open-range',
    title: 'Replace the date cast with a raw half-open timestamp range',
    sql,
    rationale:
      `The display/grouping cast remains unchanged, but the WHERE clause now bounds raw ${column}, making the coupled B-tree or BRIN path usable. The exclusive upper boundary includes the entire final calendar day.`,
    equivalence: 'exact',
    equivalenceNotes:
      `The two un-offset ${literalType} boundaries use the same session-local calendar-date semantics as the original cast. If the business means a fixed zone, pin that zone explicitly before deployment.`,
    expectedSpeedup:
      'Predicted/unverified: unlocks raw-column block or B-tree range elimination. No ratio is claimed without measured plan evidence.',
    requiresIndexes: required ? [required.id] : undefined,
    priority: 1,
  };
}

function rewriteTopPerGroup(
  ir: QueryIR,
  catalog: Catalog,
  root: QueryBlockIR,
  indexes: IndexRecommendation[],
): Rewrite | undefined {
  if (root.relations.length !== 1 || root.relations[0]!.kind !== 'table' || root.joins.length) return undefined;
  const child = ir.blocks.find((block) =>
    block.correlated && block.aggregates.length === 1 && ['max', 'min'].includes(block.aggregates[0]!.func.toLowerCase()),
  );
  const parentPredicate = child && root.predicates.find((predicate) =>
    predicate.kind === 'subquery' && nestedBlockIds(predicate).includes(child.id),
  );
  const aggregate = child?.aggregates[0];
  const innerRelation = child?.relations[0];
  const outerRelation = root.relations[0]!;
  const correlation = child?.predicates.find((predicate) => predicate.kind === 'join');
  const innerKey = correlation?.columns.find((column) => column.alias === innerRelation?.alias);
  const outerKey = correlation?.columns.find((column) => column.alias === outerRelation.alias);
  const extreme = child?.projections.find((projection) => projection.sql === aggregate?.sql)?.columns[0];
  const outerValue = parentPredicate?.columns[0];
  if (!child || !parentPredicate || !aggregate || !innerRelation || innerRelation.source !== outerRelation.source ||
      !innerKey || !outerKey || !extreme || !outerValue || child.joins.length || child.groupBy.length) return undefined;
  if (child.predicates.filter((predicate) => predicate !== correlation).length) return undefined;

  const cte = unusedAlias(root, 'sqlsage_extreme');
  const cteSql =
    `SELECT ${sqlRef(innerKey)} AS ${quoteIdentifier('group_key')}, ${aggregate.sql} AS ${quoteIdentifier('extreme_value')} ` +
    `FROM ${qualifiedTable(catalog, innerRelation.source)} AS ${quoteIdentifier(innerRelation.alias)} GROUP BY ${sqlRef(innerKey)}`;
  const otherWhere = root.predicates.filter((predicate) => predicate.clause === 'where' && predicate !== parentPredicate);
  const select = root.projections.map((projection) => renderProjection(projection)).join(', ');
  const join =
    `${quoteIdentifier(cte)}.${quoteIdentifier('group_key')} = ${sqlRef(outerKey)} AND ` +
    `${quoteIdentifier(cte)}.${quoteIdentifier('extreme_value')} = ${sqlRef(outerValue)}`;
  const where = otherWhere.length ? `\nWHERE ${otherWhere.map((predicate) => predicate.sql).join(' AND ')}` : '';
  const order = renderOrderLimit(root, true);
  const sql =
    `WITH ${quoteIdentifier(cte)} AS (${cteSql})\nSELECT ${select}\nFROM ${renderRelation(catalog, outerRelation)} ` +
    `JOIN ${quoteIdentifier(cte)} ON ${join}${where}${order};`;
  const required = findIndex(indexes, innerRelation.source, [innerKey.column, extreme.column], 'top-per-group');
  return {
    id: 'rewrite-correlated-extreme-to-grouped-join',
    title: 'Compute the per-group extreme once and join all ties',
    sql,
    rationale:
      `The grouped CTE computes ${aggregate.func.toUpperCase()}(${extreme.column}) once per ${innerKey.column}; joining it back replaces one correlated aggregate per outer row with setwise work.`,
    equivalence: 'exact',
    equivalenceNotes:
      'Equality against the grouped extreme preserves every row tied at the maximum/minimum, exactly like the original correlated equality. It deliberately avoids DISTINCT ON and row_number(), which would choose only one tie.',
    expectedSpeedup:
      'Predicted/unverified: removes outer-row-count correlated aggregate invocations. The covering group/order index can reduce sorting and heap access, but PostgreSQL 16 must still process the relevant index entries.',
    requiresIndexes: required ? [required.id] : undefined,
    priority: 1,
  };
}

// ---------------------------------------------------------------------------
// Conservative SELECT renderer and proofs
// ---------------------------------------------------------------------------

function renderSelect(block: QueryBlockIR, catalog: Catalog, options: RenderOptions = {}): string | undefined {
  if (block.kind !== 'select' || block.setOp || block.relations.some((relation) => relation.kind !== 'table')) return undefined;
  if (block.joins.length > Math.max(0, block.relations.length - 1)) return undefined;
  const projectionSql = block.projections.map((projection, index) =>
    renderProjection(projection, options.projectionOverrides?.get(index)),
  ).join(', ');
  if (!projectionSql) return undefined;
  const first = block.relations[0];
  if (!first) return undefined;
  const from = [renderRelation(catalog, first, options.relationOverrides?.get(first.alias))];
  for (const relation of block.relations.slice(1)) {
    const join = block.joins.find((candidate) => candidate.rightRelation === relation.alias);
    if (!join) return undefined;
    const rendered = renderRelation(catalog, relation, options.relationOverrides?.get(relation.alias));
    if (join.type === 'cross' && !join.equiKeys.length && !join.residualPredicates.length) from.push(`CROSS JOIN ${rendered}`);
    else from.push(`${joinKeyword(join.type)} ${rendered} ON ${joinCondition(join)}`);
  }
  from.push(...(options.extraJoins ?? []));

  const predicates = block.predicates.filter((predicate) => predicate.clause === 'where').map((predicate) =>
    options.whereOverrides?.get(sqlKey(predicate.sql)) ?? predicate.sql,
  );
  predicates.push(...(options.extraWhere ?? []));
  const where = predicates.length ? `\nWHERE ${predicates.map(parenthesizeBoolean).join(' AND ')}` : '';
  const group = block.groupByExpressions?.length
    ? `\nGROUP BY ${block.groupByExpressions.map((item) => item.sql).join(', ')}`
    : '';
  const having = block.having.length ? `\nHAVING ${block.having.map((predicate) => predicate.sql).join(' AND ')}` : '';
  const orderLimit = renderOrderLimit(block, !options.omitOffset);
  const distinct = options.distinct ?? block.distinct;
  return `SELECT ${distinct ? 'DISTINCT ' : ''}${projectionSql}\nFROM ${from.join('\n')}${where}${group}${having}${orderLimit};`;
}

function renderProjection(
  projection: QueryBlockIR['projections'][number],
  override?: string,
): string {
  const expression = override ?? projection.sql;
  return projection.alias ? `${expression} AS ${quoteIdentifier(projection.alias)}` : expression;
}

function renderRelation(catalog: Catalog, relation: QueryBlockIR['relations'][number], override?: string): string {
  return override ?? `${qualifiedTable(catalog, relation.source)} AS ${quoteIdentifier(relation.alias)}`;
}

function joinKeyword(type: QueryBlockIR['joins'][number]['type']): string {
  if (type === 'inner') return 'JOIN';
  if (type === 'left') return 'LEFT JOIN';
  if (type === 'right') return 'RIGHT JOIN';
  if (type === 'full') return 'FULL JOIN';
  if (type === 'lateral') return 'JOIN LATERAL';
  return `${type.toUpperCase()} JOIN`;
}

function joinCondition(join: QueryBlockIR['joins'][number]): string {
  return [
    ...join.equiKeys.map((key) => `${sqlRef(key.left)} = ${sqlRef(key.right)}`),
    ...join.residualPredicates.map((predicate) => predicate.sql),
  ].join(' AND ') || 'TRUE';
}

function renderOrderLimit(block: QueryBlockIR, includeOffset: boolean): string {
  const order = block.orderBy.length
    ? `\nORDER BY ${block.orderBy.map((item) =>
        `${item.sql} ${item.direction.toUpperCase()}${item.nulls ? ` NULLS ${item.nulls.toUpperCase()}` : ''}`,
      ).join(', ')}`
    : '';
  const limit = block.limit !== undefined ? `\nLIMIT ${block.limit}` : '';
  const offset = includeOffset && block.offset !== undefined ? `\nOFFSET ${block.offset}` : '';
  return `${order}${limit}${offset}`;
}

function parenthesizeBoolean(sql: string): string {
  return /\b(?:AND|OR)\b/i.test(sql) ? `(${sql})` : sql;
}

function projectedKeyIsUnique(catalog: Catalog, block: QueryBlockIR, alias: string, tableName: string): boolean {
  const projected = unique(block.projections.flatMap((projection) => projection.columns)
    .filter((column) => column.alias === alias).map((column) => column.column));
  const table = findTable(catalog, tableName);
  if (!table) return false;
  const covered = (columns: string[] | undefined) => !!columns?.length && columns.every((column) => projected.includes(column));
  return covered(table.primaryKey) || table.indexes.some((index) => index.unique && !index.where && covered(index.columns));
}

function orderingIsUnique(catalog: Catalog, tableName: string, columns: string[]): boolean {
  const table = findTable(catalog, tableName);
  if (!table) return false;
  const covered = (key: string[] | undefined) => !!key?.length && key.every((column) => columns.includes(column));
  return covered(table.primaryKey) || table.indexes.some((index) => index.unique && !index.where && covered(index.columns));
}

// ---------------------------------------------------------------------------
// Small structural helpers
// ---------------------------------------------------------------------------

function findIndex(
  indexes: IndexRecommendation[],
  table: string | undefined,
  requiredColumns: string[],
  _purpose: string,
): IndexRecommendation | undefined {
  if (!table) return undefined;
  const normalized = requiredColumns.map((column) => column.toLowerCase());
  return indexes.find((index) =>
    index.table.toLowerCase() === table.toLowerCase() &&
    normalized.every((column) => index.columns.some((key) => baseKey(key) === column)),
  );
}

function predicateForFinding(block: QueryBlockIR, finding: Finding | undefined): Predicate | undefined {
  return finding && block.predicates.find((predicate) => sameSql(predicate.sql, finding.evidence.sqlFragment));
}

function firstFinding(findings: Finding[], id: string): Finding | undefined {
  return findings.find((finding) => finding.id === id || finding.id.startsWith(`${id}-`));
}

function hasFinding(findings: Finding[], id: string): boolean {
  return !!firstFinding(findings, id);
}

function singleColumn(predicate: Predicate): ResolvedColumnRef | undefined {
  const columns = predicate.columns.filter((column) => !column.unresolved);
  return columns.length === 1 ? columns[0] : undefined;
}

function projectionUsingBlock(
  block: QueryBlockIR,
  childId: string,
): { projection: QueryBlockIR['projections'][number]; index: number } | undefined {
  const index = block.projections.findIndex((projection) => nestedBlockIds(projection).includes(childId));
  return index < 0 ? undefined : { projection: block.projections[index]!, index };
}

function correlationSignature(block: QueryBlockIR): string {
  return unique((block.correlationRefs ?? []).map((ref) => `${ref.table ?? ref.alias}.${ref.column}`)).sort().join('|');
}

function normalizeAlias(sql: string, from: string, to: string): string {
  if (from === to) return sql;
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sql.replace(new RegExp(`\\b${escaped}\\.`, 'g'), `${to}.`);
}

function unusedAlias(block: QueryBlockIR, base: string): string {
  const used = new Set(block.relations.map((relation) => relation.alias.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (used.has(`${base}_${suffix}`.toLowerCase())) suffix++;
  return `${base}_${suffix}`;
}

function sqlRef(ref: ResolvedColumnRef): string {
  return `${ref.alias ? `${quoteIdentifier(ref.alias)}.` : ''}${quoteIdentifier(ref.column)}`;
}

function sqlKey(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameSql(a: string, b: string): boolean {
  return sqlKey(a) === sqlKey(b);
}

function baseKey(key: string): string {
  return key.replace(/\s+(ASC|DESC)$/i, '').replace(/^\(+|\)+$/g, '').toLowerCase();
}

function validMonth(year: number, month: number): boolean {
  return Number.isInteger(year) && year >= 1 && year <= 9998 && Number.isInteger(month) && month >= 1 && month <= 12;
}

function parseIsoDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date;
}

function isoDate(date: Date): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function joinWords(values: string[]): string {
  const uniqueValues = unique(values);
  return uniqueValues.length <= 1 ? uniqueValues[0] ?? 'the affected relation' : `${uniqueValues.slice(0, -1).join(', ')} and ${uniqueValues.at(-1)}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
