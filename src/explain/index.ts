/**
 * M2 -- plain-English query semantics.
 *
 * This module deliberately describes the logical result only. Physical access
 * paths and tuning advice belong to M3-M6. Every rule below consumes structural
 * QueryIR fields; the corpus is a test suite, never an input to this module.
 */
import { findTable } from '../catalog.ts';
import { blockById, outerJoinDemotions } from '../ir/index.ts';
import type {
  Catalog,
  Predicate,
  QueryBlockIR,
  QueryIR,
  ResolvedColumnRef,
  SemanticExplanation,
} from '../types.ts';

type Caveat = SemanticExplanation['caveats'][number];
type Step = SemanticExplanation['steps'][number];

interface NullableNotIn {
  predicate: Predicate;
  child: QueryBlockIR;
  nullableColumn: ResolvedColumnRef;
}

interface AggregateFanOut {
  projection: QueryBlockIR['projections'][number];
  multipliedAliases: string[];
}

export function explainSemantics(ir: QueryIR, catalog: Catalog): SemanticExplanation {
  const root = blockById(ir, ir.rootBlockId) ?? ir.blocks[0];
  if (!root) return emptyExplanation(ir);

  const nullableNotIns = findNullableNotIns(ir);
  const aggregateFanOut = findAggregateFanOut(root);
  const demotions = outerJoinDemotions(ir).filter((item) => item.blockId === root.id);
  const grain = resultGrain(root, catalog);
  const columns = root.projections.map((projection) => ({
    name: projectionName(projection),
    meaning: projectionMeaning(projection, root, ir),
  }));

  return {
    headline: headline(root, grain, columns.map((column) => column.name), nullableNotIns, aggregateFanOut, demotions),
    steps: logicalSteps(root, ir),
    resultShape: { grain, columns },
    caveats: semanticCaveats(ir, root, catalog, nullableNotIns, aggregateFanOut, demotions),
  };
}

function emptyExplanation(ir: QueryIR): SemanticExplanation {
  const reason = ir.bindingErrors.find((error) => error.severity === 'error')?.message;
  return {
    headline: reason
      ? `The statement's result could not be described safely because ${lowerFirst(reason)}.`
      : 'The statement contains no bound query block to explain.',
    steps: [],
    resultShape: { grain: 'Unknown because no result-producing query block was bound.', columns: [] },
    caveats: reason ? [{ issue: 'Incomplete binding', why: reason }] : [],
  };
}

function headline(
  root: QueryBlockIR,
  grain: string,
  names: string[],
  nullableNotIns: NullableNotIn[],
  aggregateFanOut: AggregateFanOut[],
  demotions: ReturnType<typeof outerJoinDemotions>,
): string {
  const selected = naturalList(names.slice(0, 4).map((name) => `\`${name}\``));
  const more = names.length > 4 ? ` and ${names.length - 4} other output${names.length === 5 ? '' : 's'}` : '';

  if (nullableNotIns.some((item) => root.predicates.includes(item.predicate))) {
    return `Correctness risk: returns ${grainToHeadline(grain)}, but one NULL in the excluded subquery makes every otherwise-unmatched comparison unknown and can empty the result.`;
  }
  if (aggregateFanOut.length) {
    const aliases = naturalList(unique(aggregateFanOut.flatMap((item) => item.multipliedAliases)).map(code));
    return `Correctness risk: returns ${grainToHeadline(grain)}, but joined rows repeat ${aliases} before its aggregates are calculated.`;
  }
  if (demotions.length) {
    return `Intent risk: returns only matched joined rows because a later condition removes the unmatched rows that the outer join initially preserves.`;
  }

  const purpose = root.aggregates.length
    ? `summaries containing ${selected}${more}`
    : `rows containing ${selected}${more}`;
  return `Returns ${purpose}; ${lowerFirst(grain)}.`;
}

function logicalSteps(root: QueryBlockIR, ir: QueryIR): Step[] {
  const steps: Step[] = [];
  const first = root.relations[0];
  if (first) {
    steps.push({
      title: `Start with ${displayRelation(first.source, first.alias)}`,
      detail: `Begin with rows produced by ${relationKind(first.kind)} ${code(first.source)}${first.alias === first.source ? '' : `, named ${code(first.alias)} in this query`}.`,
    });
  }

  for (const join of root.joins) {
    const condition = [
      ...join.equiKeys.map((key) => `${columnLabel(key.left)} equals ${columnLabel(key.right)}`),
      ...join.residualPredicates.map((predicate) => code(predicate.sql)),
    ];
    const kind = join.type === 'left'
      ? `Keep every row already present and attach matching ${code(join.rightRelation)} rows; use empty values on that side when none match`
      : join.type === 'right'
        ? `Keep every ${code(join.rightRelation)} row and attach matching rows from the existing input`
        : join.type === 'full'
          ? 'Keep both matched rows and unmatched rows from either side'
          : join.type === 'cross'
            ? `Pair every existing row with every ${code(join.rightRelation)} row`
            : `Keep combinations that match ${code(join.rightRelation)}`;
    steps.push({
      title: `Combine with ${code(join.rightRelation)}`,
      detail: `${kind}${condition.length ? ` when ${naturalList(condition)}` : ''}.`,
      sqlFragment: joinSql(join),
    });
  }

  const where = root.predicates.filter((predicate) => predicate.clause === 'where');
  for (const predicate of where) {
    const children = (predicate.subqueryBlockIds ?? []).map((id) => blockById(ir, id)).filter(isDefined);
    steps.push({
      title: predicate.negated && children.length ? 'Apply the exclusion test' : 'Keep qualifying rows',
      detail: predicateDetail(predicate, children),
      sqlFragment: predicate.sql,
    });
  }

  const correlated = ir.blocks.filter((block) => block.correlated && referencedByProjections(root, block.id));
  for (const child of correlated) {
    const aggregate = child.aggregates[0];
    steps.push({
      title: `Calculate ${aggregate ? aggregateDescription(aggregate.sql) : 'the related value'} for each outer row`,
      detail: `For each retained outer row, evaluate the related ${code(child.id)} query using ${naturalList((child.correlationRefs ?? []).map(columnLabel)) || 'its outer reference'}${aggregate ? ` and return ${aggregateDescription(aggregate.sql)}` : ''}.`,
      sqlFragment: child.projections[0]?.sql,
    });
  }

  if (root.groupByExpressions?.length || root.groupBy.length) {
    const keys = (root.groupByExpressions?.length
      ? root.groupByExpressions.map((expression) => expression.sql)
      : root.groupBy.map(columnLabel)).map(code);
    const calculations = root.aggregates.map((aggregate) => aggregateDescription(aggregate.sql));
    steps.push({
      title: 'Form result groups and calculate summaries',
      detail: `Put the retained rows into one group for each distinct combination of ${naturalList(keys)}${calculations.length ? `, then calculate ${naturalList(calculations)}` : ''}.`,
      sqlFragment: keys.join(', '),
    });
  } else if (root.aggregates.length) {
    steps.push({
      title: 'Calculate the summary',
      detail: `Treat all retained rows as one input and calculate ${naturalList(root.aggregates.map((aggregate) => aggregateDescription(aggregate.sql)))}.`,
    });
  }

  if (root.having.length) {
    steps.push({
      title: 'Keep qualifying summaries',
      detail: `After each group has its calculated values, retain only groups for which ${naturalList(root.having.map((predicate) => code(predicate.sql)))} is true. Conditions on a grouping key and conditions on a calculated aggregate have the same written location but different meanings.`,
      sqlFragment: root.having.map((predicate) => predicate.sql).join(' AND '),
    });
  }

  if (root.distinct) {
    steps.push({
      title: 'Remove duplicate output rows',
      detail: `After choosing ${naturalList(root.projections.map((projection) => code(projectionName(projection))))}, keep one copy of each equal output combination.`,
    });
  }

  if (root.orderBy.length) {
    steps.push({
      title: 'Order the result',
      detail: `Sort by ${naturalList(root.orderBy.map((item) => `${code(item.sql)} ${item.direction === 'desc' ? 'from highest to lowest' : 'from lowest to highest'}${item.nulls ? `, with empty values ${item.nulls}` : ''}`))}.`,
      sqlFragment: root.orderBy.map((item) => item.sql).join(', '),
    });
  }

  if (root.offset !== undefined || root.limit !== undefined) {
    const parts: string[] = [];
    if (root.offset) parts.push(`discard the first ${formatNumber(root.offset)} rows of that ordering`);
    if (root.limit !== undefined) parts.push(`return at most ${formatNumber(root.limit)} rows after that`);
    steps.push({ title: 'Apply the requested window', detail: `${capitalize(naturalList(parts))}.` });
  }

  if (steps.length === 0) {
    steps.push({ title: 'Produce the selected values', detail: 'Return the values named in the select list.' });
  }
  return steps;
}

function semanticCaveats(
  ir: QueryIR,
  root: QueryBlockIR,
  catalog: Catalog,
  nullableNotIns: NullableNotIn[],
  aggregateFanOut: AggregateFanOut[],
  demotions: ReturnType<typeof outerJoinDemotions>,
): Caveat[] {
  const caveats: Caveat[] = [];

  for (const item of nullableNotIns.filter((candidate) => root.predicates.includes(candidate.predicate))) {
    caveats.push({
      issue: 'NULL can poison NOT IN',
      why: `${columnLabel(item.nullableColumn)} can be NULL. If the subquery emits even one NULL and no equal value is found for an outer row, NOT IN evaluates to unknown rather than true; WHERE removes that row. Duplicate non-NULL values do not change this behavior.`,
      sqlFragment: item.predicate.sql,
    });
  }

  for (const item of aggregateFanOut) {
    caveats.push({
      issue: 'An aggregate reads multiplied source rows',
      why: `${code(item.projection.sql)} uses ${naturalList(item.multipliedAliases.map(code))}, whose rows a one-to-many join repeats before grouping. The value therefore adds the same source value once per matching detail row; the multiplier depends on the data.`,
      sqlFragment: item.projection.sql,
    });
  }

  if (root.aggregates.some((aggregate) => /^count\s*\(\s*\*\s*\)$/i.test(aggregate.sql)) &&
      root.joins.some((join) => join.fanOutSide === 'left' || join.fanOutSide === 'both')) {
    caveats.push({
      issue: 'count(*) counts the expanded joined rows',
      why: 'The count increases once for every surviving joined combination. It is not automatically a count of the first relation, distinct business records, or a quantity stored on a detail row.',
      sqlFragment: root.aggregates.find((aggregate) => /^count\s*\(\s*\*\s*\)$/i.test(aggregate.sql))?.sql,
    });
  }

  for (const item of demotions) {
    caveats.push({
      issue: 'The outer join no longer preserves unmatched rows',
      why: `${code(item.predicate.sql)} is evaluated after the ${item.join.type.toUpperCase()} JOIN and cannot be true for the empty values supplied to ${code(item.relation)}. Unmatched rows are therefore removed. Moving the condition into the join condition would produce a different result; using an inner join would state the current result more directly.`,
      sqlFragment: item.predicate.sql,
    });
  }

  const zoneFragments = timezoneSensitiveFragments(root);
  if (zoneFragments.length) {
    caveats.push({
      issue: 'Time boundaries depend on the session time zone',
      why: 'A timestamp-with-time-zone converted to a month or date, or a zone-less timestamp-with-time-zone literal, is interpreted using the current session time zone. Different session settings can move absolute instants across the written boundary.',
      sqlFragment: zoneFragments[0],
    });
  }

  const between = root.predicates.find((predicate) => /\bBETWEEN\b/i.test(predicate.sql));
  if (between) {
    caveats.push({
      issue: 'BETWEEN includes both endpoints',
      why: 'Rows equal to either written boundary qualify. Any reformulation using timestamps must preserve the complete final day, usually by using the following boundary as an exclusive upper limit.',
      sqlFragment: between.sql,
    });
  }

  if (root.distinct && root.joins.some((join) => join.fanOut)) {
    caveats.push({
      issue: 'Duplicates exist before DISTINCT',
      why: 'One-to-many joins can create several qualifying paths to the same selected values. DISTINCT removes equal output rows only after that expansion and does not mean that just one joined row existed.',
    });
  }

  for (const projection of root.projections) {
    if (!/count\s*\(\s*distinct\b/i.test(projection.sql)) continue;
    const nullable = projection.columns.filter((column) => column.nullable !== false);
    caveats.push({
      issue: 'The distinct count ignores NULL values',
      why: `${code(projection.sql)} counts each different non-NULL value once. Repeated values count once, while ${nullable.length ? naturalList(nullable.map(columnLabel)) : 'a NULL input'} contributes nothing.`,
      sqlFragment: projection.sql,
    });
  }

  const topPerGroup = topPerGroupPredicates(ir, root);
  for (const item of topPerGroup) {
    caveats.push({
      issue: 'Ties at the per-group extreme are preserved',
      why: `The equality compares each outer row with ${code(item.aggregate.sql)} for its correlated group. Every row tied at that maximum or minimum qualifies; the result is not guaranteed to contain exactly one row per group unless a separate uniqueness rule proves it.`,
      sqlFragment: item.predicate.sql,
    });
  }

  const scalarAggregates = root.projections.flatMap((projection) =>
    (projection.subqueryBlockIds ?? []).map((id) => ({ projection, child: blockById(ir, id) })),
  ).filter((item) => item.child?.correlated && item.child.aggregates.length && !item.child.groupBy.length);
  if (scalarAggregates.length) {
    const counts = scalarAggregates.filter((item) => item.child!.aggregates.some((aggregate) => aggregate.func === 'count'));
    const nullable = scalarAggregates.filter((item) => item.child!.aggregates.some((aggregate) => aggregate.func !== 'count'));
    caveats.push({
      issue: 'Empty correlated groups still have defined aggregate behavior',
      why: `${counts.length ? `${naturalList(counts.map((item) => code(projectionName(item.projection))))} returns 0 when no related row exists` : ''}${counts.length && nullable.length ? ', while ' : ''}${nullable.length ? `${naturalList(nullable.map((item) => code(projectionName(item.projection))))} returns NULL for an empty related input` : ''}. The outer row is not removed by a scalar aggregate without its own grouping key.`,
      sqlFragment: scalarAggregates[0]?.projection.sql,
    });
  }

  if (root.offset && root.offset > 0) {
    caveats.push({
      issue: 'Pagination is position-based',
      why: `The query skips positions rather than remembering the identity of the last returned row. Inserts, deletes, or updates before a later request can move rows across the ${formatNumber(root.offset)}-row boundary.`,
    });
  }

  if (root.groupByExpressions?.some((expression) => expression.ordinal !== undefined)) {
    const ordinal = root.groupByExpressions.find((expression) => expression.ordinal !== undefined)!;
    caveats.push({
      issue: 'The grouping key is positional',
      why: `${code(String(ordinal.ordinal))} refers to select-list position ${ordinal.ordinal}. Reordering the selected expressions without changing the ordinal can silently change or invalidate the grouping meaning.`,
      sqlFragment: ordinal.sql,
    });
  }

  if (root.orderBy.length && !orderingIsTotal(root, catalog)) {
    caveats.push({
      issue: 'Tied rows are not fully ordered',
      why: 'The requested ordering does not include a key that is proven unique for every output row. Rows tied on all ordering expressions may appear in either relative order; when a row limit is present, ties at the boundary can also change which rows are returned.',
      sqlFragment: root.orderBy.map((item) => item.sql).join(', '),
    });
  } else if (!root.orderBy.length) {
    caveats.push({
      issue: 'No output order is promised',
      why: 'Without an explicit final ordering, consumers must not rely on the order rows happen to be returned in.',
    });
  }

  return dedupeCaveats(caveats);
}

/**
 * Grain of a set operation, which is not the grain of either arm.
 *
 * The binder exposes the left arm's projections on the set-op block so the
 * result's columns can be named. Falling through to the ordinary logic then
 * described the whole statement as "one row per qualifying `main#1` row" — the
 * left arm alone, with the right arm's rows silently absent from the claim.
 */
function setOperationGrain(root: QueryBlockIR): string | undefined {
  if (!root.setOp) return undefined;
  const arms = root.relations.map((relation) => code(relation.source));
  const both = arms.length === 2 ? `${arms[0]} and ${arms[1]}` : naturalList(arms);
  switch (root.setOp.op) {
    case 'union-all':
      return `Every row from ${both}, concatenated without deduplication — the arms' row counts add`;
    case 'union':
      return `Each distinct row appearing in ${both}, with duplicates removed across both arms`;
    case 'intersect':
      return `Each distinct row appearing in both ${both}`;
    case 'except':
      return `Each distinct row of ${arms[0]} that does not appear in ${arms[1]}`;
  }
}

function resultGrain(root: QueryBlockIR, catalog: Catalog): string {
  const setOp = setOperationGrain(root);
  if (setOp) return setOp;
  const groups = root.groupByExpressions?.length
    ? root.groupByExpressions.map((expression) => expression.sql)
    : root.groupBy.map(columnLabel);
  if (groups.length) {
    const fixed = root.groupByExpressions?.length
      ? root.groupByExpressions.every((expression) =>
          expressionFixedByEquality(root, expression.sql)
          || (expression.columns.length === 1 && columnFixedByEquality(root, expression.columns[0]!)))
      : root.groupBy.every((column) => columnFixedByEquality(root, column));
    const having = root.having.length ? ' and passes the post-group conditions' : '';
    return `${fixed ? 'At most one row for the fixed grouping value' : `One row per distinct combination of ${naturalList(groups.map(code))}`} that has at least one qualifying input row${having}`;
  }
  if (root.aggregates.length) return 'Exactly one summary row over the qualifying input, even when that input is empty';
  if (root.distinct) {
    const identity = projectedIdentity(root, catalog);
    return identity
      ? `One row per distinct ${code(identity)} row represented by at least one qualifying join path`
      : `One row per distinct combination of ${naturalList(root.projections.map((projection) => code(projectionName(projection))))}`;
  }
  const top = root.predicates.some((predicate) => predicate.kind === 'subquery' && /\b(max|min)\s*\(/i.test(predicate.sql));
  if (top) {
    const first = root.relations[0];
    return `One row per matching ${code(first?.source ?? 'outer input')} row tied at its correlated group's extreme value`;
  }
  if (root.joins.length) {
    const aliases = root.relations.map((relation) => code(relation.alias));
    return `One row per surviving joined combination of ${naturalList(aliases)}`;
  }
  const relation = root.relations[0];
  return relation
    ? `One row per qualifying ${code(relationRowKind(relation.source))} row`
    : 'One row per qualifying input row';
}

function relationRowKind(source: string): string {
  const name = source.split('.').at(-1) ?? source;
  const words = name.replace(/_/g, ' ');
  if (/ies$/i.test(words)) return `${words.slice(0, -3)}y`;
  if (/s$/i.test(words) && !/ss$/i.test(words)) return words.slice(0, -1);
  return words;
}

function projectionMeaning(
  projection: QueryBlockIR['projections'][number],
  root: QueryBlockIR,
  ir: QueryIR,
): string {
  const sql = projection.sql.trim();
  const countDistinct = sql.match(/^count\s*\(\s*distinct\s+(.+)\)$/i);
  if (countDistinct) return `The number of different non-NULL values of ${code(countDistinct[1]!.trim())} in each result group.`;
  if (/^count\s*\(\s*\*\s*\)$/i.test(sql)) {
    return root.groupBy.length || root.groupByExpressions?.length
      ? 'The number of joined input rows in this group.'
      : 'The number of qualifying input rows.';
  }
  const aggregate = sql.match(/^(sum|avg|min|max)\s*\((.+)\)$/i);
  if (aggregate) {
    const words: Record<string, string> = { sum: 'total', avg: 'average', min: 'smallest value', max: 'greatest value' };
    return `The ${words[aggregate[1]!.toLowerCase()]} of non-NULL ${code(aggregate[2]!.trim())} values in the relevant group.`;
  }
  const childIds = projection.subqueryBlockIds ?? [];
  if (childIds.length) {
    const child = blockById(ir, childIds[0]!);
    const childAggregate = child?.aggregates[0];
    if (childAggregate) return `${capitalize(aggregateDescription(childAggregate.sql))}, calculated separately for this outer row.`;
    return 'A scalar value calculated by the related subquery for this outer row.';
  }
  if (/::\s*date\b/i.test(sql)) return `The session-local calendar date derived from ${naturalList(projection.columns.map(columnLabel))}.`;
  if (/->>/.test(sql)) return `Text extracted from JSON by ${code(sql)}; a missing or JSON-null value produces SQL NULL.`;
  if (projection.columns.length === 1) {
    const column = projection.columns[0]!;
    return `The ${code(column.column)} value from ${code(column.table ?? column.alias ?? 'the input')}.`;
  }
  return `The value produced by ${code(sql)}.`;
}

function findNullableNotIns(ir: QueryIR): NullableNotIn[] {
  const out: NullableNotIn[] = [];
  for (const block of ir.blocks) {
    for (const predicate of block.predicates) {
      if (!predicate.negated || predicate.kind !== 'subquery' || !/\bNOT\s+IN\b/i.test(predicate.sql)) continue;
      for (const id of predicate.subqueryBlockIds ?? []) {
        const child = blockById(ir, id);
        if (!child) continue;
        const nullableColumn = child.projections.flatMap((projection) => projection.columns).find((column) => column.nullable !== false);
        if (nullableColumn) out.push({ predicate, child, nullableColumn });
      }
    }
  }
  return out;
}

function findAggregateFanOut(root: QueryBlockIR): AggregateFanOut[] {
  const multiplied = new Set(root.joins.flatMap((join) => join.multipliedRelations ?? []));
  const out: AggregateFanOut[] = [];
  for (const projection of root.projections) {
    if (!/^\s*(sum|avg|min|max|array_agg|string_agg|bool_and|bool_or)\s*\(/i.test(projection.sql)) continue;
    const aliases = unique(projection.columns.map((column) => column.alias).filter(isDefined).filter((alias) => multiplied.has(alias)));
    if (aliases.length) out.push({ projection, multipliedAliases: aliases });
  }
  return out;
}

function predicateDetail(predicate: Predicate, children: QueryBlockIR[]): string {
  if (predicate.negated && /\bNOT\s+IN\b/i.test(predicate.sql) && children.length) {
    return `Build the values returned by the nested query, then keep an outer row only when comparison with every value is true. If the nested values contain NULL, a nonmatching row becomes unknown rather than true and is removed.`;
  }
  if (predicate.kind === 'subquery' && children.some((child) => child.correlated)) {
    return `For each candidate outer row, calculate the related nested-query value and keep the row only when ${code(predicate.sql)} is true.`;
  }
  if (predicate.kind === 'boolean' && /\bOR\b/i.test(predicate.sql)) {
    return `Keep a row when at least one branch of ${code(predicate.sql)} is true; satisfying both branches still contributes one input row.`;
  }
  if (predicate.kind === 'in-list') return `Keep rows whose value belongs to the list in ${code(predicate.sql)}.`;
  if (predicate.kind === 'range') return `Keep rows inside the boundary expressed by ${code(predicate.sql)}.`;
  return `Keep a row only when ${code(predicate.sql)} evaluates to true; false and unknown are removed.`;
}

function aggregateDescription(sql: string): string {
  if (/^count\s*\(\s*distinct/i.test(sql)) return `the number of distinct non-NULL values requested by ${code(sql)}`;
  if (/^count\s*\(\s*\*\s*\)/i.test(sql)) return 'the number of input rows';
  const match = sql.match(/^\s*(sum|avg|min|max)\s*\((.+)\)/i);
  if (!match) return `the value of ${code(sql)}`;
  const words: Record<string, string> = { sum: 'total', avg: 'average', min: 'smallest value', max: 'greatest value' };
  return `the ${words[match[1]!.toLowerCase()]} of ${code(match[2]!.trim())}`;
}

function topPerGroupPredicates(ir: QueryIR, root: QueryBlockIR): Array<{ predicate: Predicate; aggregate: QueryBlockIR['aggregates'][number] }> {
  const out: Array<{ predicate: Predicate; aggregate: QueryBlockIR['aggregates'][number] }> = [];
  for (const predicate of root.predicates) {
    for (const id of predicate.subqueryBlockIds ?? []) {
      const child = blockById(ir, id);
      const aggregate = child?.aggregates.find((item) => item.func === 'max' || item.func === 'min');
      if (child?.correlated && aggregate && /\s=\s/.test(predicate.sql)) out.push({ predicate, aggregate });
    }
  }
  return out;
}

function timezoneSensitiveFragments(root: QueryBlockIR): string[] {
  const fragments = [
    ...root.predicates.map((predicate) => predicate.sql),
    ...(root.groupByExpressions ?? []).map((expression) => expression.sql),
    ...root.projections.map((projection) => projection.sql),
  ];
  return unique(fragments.filter((sql) =>
    /date_trunc\s*\(/i.test(sql) ||
    /::\s*date\b/i.test(sql) ||
    /TIMESTAMPTZ\s*'\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?'/i.test(sql),
  ));
}

/**
 * True when an equality predicate pins `group` to a single value: the group
 * expression appears verbatim on one side and the other side is a constant or
 * parameter. A `column = column` equality never counts — it leaves the group
 * with one row per distinct value, not one row total.
 */
function expressionFixedByEquality(root: QueryBlockIR, group: string): boolean {
  if (/^\d+$/.test(group.trim())) {
    const ordinal = Number(group.trim());
    const projection = root.projections[ordinal - 1];
    return projection ? predicatePinsConstant(root, projection.sql) : false;
  }
  return predicatePinsConstant(root, group);
}

/** Column-based variant that also matches qualified-vs-unqualified spellings. */
function columnFixedByEquality(root: QueryBlockIR, column: ResolvedColumnRef): boolean {
  if (!column.alias && !column.table) return false;
  return root.predicates.some((predicate) => {
    const operands = predicate.equalityOperands;
    if (predicate.kind !== 'equality' || !operands) return false;
    if (operands.rightConstant && operandIsColumn(predicate, operands.left, column)) return true;
    if (operands.leftConstant && operandIsColumn(predicate, operands.right, column)) return true;
    return false;
  });
}

function predicatePinsConstant(root: QueryBlockIR, group: string): boolean {
  const target = normalize(group.replace(/`/g, ''));
  return root.predicates.some((predicate) => {
    const operands = predicate.equalityOperands;
    if (predicate.kind !== 'equality' || !operands) return false;
    return (normalize(operands.left) === target && operands.rightConstant)
        || (normalize(operands.right) === target && operands.leftConstant);
  });
}

/**
 * True when the operand is a *bare* column reference spelling the same column
 * as `column` (qualified by alias or table, or unqualified). The resolved-ref
 * guard prevents an unqualified operand of the same name from matching a
 * different relation's column.
 */
function operandIsColumn(predicate: Predicate, operandSql: string, column: ResolvedColumnRef): boolean {
  const op = normalize(operandSql);
  const forms = [
    column.alias ? `${column.alias}.${column.column}` : null,
    column.table ? `${column.table}.${column.column}` : null,
    column.column,
  ].filter((form): form is string => form !== null).map(normalize);
  if (!forms.includes(op)) return false;
  return predicate.columns.some((ref) => ref.column === column.column
    && (ref.alias ?? '') === (column.alias ?? '') && (ref.table ?? '') === (column.table ?? ''));
}

function projectedIdentity(root: QueryBlockIR, catalog: Catalog): string | undefined {
  for (const relation of root.relations) {
    const table = findTable(catalog, relation.source);
    if (!table?.primaryKey?.length) continue;
    const projected = new Set(root.projections.flatMap((projection) => projection.columns)
      .filter((column) => column.alias === relation.alias)
      .map((column) => column.column));
    if (table.primaryKey.every((column) => projected.has(column))) return relation.source;
  }
  return undefined;
}

function orderingIsTotal(root: QueryBlockIR, catalog: Catalog): boolean {
  if (root.groupByExpressions?.length && root.groupByExpressions.every((expression) => expressionFixedByEquality(root, expression.sql))) return true;
  const ordered = root.orderBy.map((item) => item.column).filter(isDefined);
  for (const relation of root.relations) {
    const table = findTable(catalog, relation.source);
    if (!table?.primaryKey?.length) continue;
    if (table.primaryKey.every((key) => ordered.some((column) => column.alias === relation.alias && column.column === key))) return true;
  }
  if (root.groupByExpressions?.length) {
    const orderSql = new Set(root.orderBy.map((item) => normalize(item.sql)));
    const projectionAliases = new Map(root.projections.filter((projection) => projection.alias).map((projection) => [normalize(projection.alias!), normalize(projection.sql)]));
    return root.groupByExpressions.every((expression) => {
      const target = normalize(expression.sql);
      return orderSql.has(target) || [...orderSql].some((sql) => projectionAliases.get(sql) === target);
    });
  }
  return false;
}

function referencedByProjections(root: QueryBlockIR, id: string): boolean {
  return root.projections.some((projection) => (projection.subqueryBlockIds ?? []).includes(id));
}

function projectionName(projection: QueryBlockIR['projections'][number]): string {
  if (projection.alias) return projection.alias;
  if (projection.columns.length === 1 && /^[\w"$]+(?:\.[\w"$]+){0,2}$/.test(projection.sql.trim())) return projection.columns[0]!.column;
  return projection.sql.trim();
}

function columnLabel(column: ResolvedColumnRef): string {
  return code(`${column.alias ?? column.table ?? '?'}.${column.column}`);
}

function joinSql(join: QueryBlockIR['joins'][number]): string | undefined {
  const sql = [
    ...join.equiKeys.map((key) => `${key.left.alias ?? key.left.table}.${key.left.column} = ${key.right.alias ?? key.right.table}.${key.right.column}`),
    ...join.residualPredicates.map((predicate) => predicate.sql),
  ];
  return sql.length ? sql.join(' AND ') : undefined;
}

function relationKind(kind: QueryBlockIR['relations'][number]['kind']): string {
  const words: Record<typeof kind, string> = {
    table: 'the table', cte: 'the named intermediate result', subquery: 'the nested result', values: 'the literal rows', function: 'the row-producing function',
  };
  return words[kind];
}

function displayRelation(source: string, alias: string): string {
  return alias === source ? code(source) : `${code(source)} (${code(alias)})`;
}

function grainToHeadline(grain: string): string {
  return lowerFirst(grain.replace(/;.*$/, ''));
}

function dedupeCaveats(caveats: Caveat[]): Caveat[] {
  const seen = new Set<string>();
  return caveats.filter((caveat) => {
    const key = `${caveat.issue}\u0000${caveat.sqlFragment ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function naturalList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, '').replace(/[()]/g, '').toLowerCase();
}

function code(value: string): string {
  return `\`${value}\``;
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function lowerFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
