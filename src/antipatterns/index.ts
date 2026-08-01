/**
 * M4 — structural correctness, intent, and performance findings.
 *
 * The detector consumes only the public QueryIR and Catalog contracts.  It does
 * not know about the judgment corpus or saved plans, and it deliberately avoids
 * turning a possible access-path improvement into a promised speedup.  M5 owns
 * index design and M6 owns complete rewrites; this module identifies the exact
 * shape that deserves their attention.
 */

import { findColumn, findTable } from '../catalog.ts';
import { nestedBlockIds, outerJoinDemotions } from '../ir/index.ts';
import type {
  Catalog,
  Finding,
  Predicate,
  QueryBlockIR,
  QueryIR,
  ResolvedColumnRef,
  Severity,
} from '../types.ts';

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

const DUPLICATE_SENSITIVE_AGGREGATES = new Set([
  'sum',
  'avg',
  'count',
  'array_agg',
  'json_agg',
  'jsonb_agg',
  'string_agg',
  'xmlagg',
]);

interface FindingSink {
  findings: Finding[];
  evidenceKeys: Set<string>;
}

interface OuterCardinality {
  rows?: number;
  exactForIr: boolean;
  relation?: string;
}

interface LikeMatch {
  fragment: string;
  identifier: string;
  pattern: string;
}

/** Detect structural query problems supported by the supplied IR and catalog. */
export function detectAntiPatterns(ir: QueryIR, catalog: Catalog): Finding[] {
  const sink: FindingSink = { findings: [], evidenceKeys: new Set() };

  detectNullableNotIn(ir, catalog, sink);
  detectAggregateFanOut(ir, catalog, sink);
  detectOuterJoinDemotions(ir, catalog, sink);
  detectDeepOffsets(ir, catalog, sink);
  detectRepeatedCorrelatedAggregates(ir, catalog, sink);
  detectCorrelatedTopPerGroup(ir, catalog, sink);
  detectDistinctFanOut(ir, catalog, sink);
  detectPredicateAccessProblems(ir, catalog, sink);
  detectDistinctAggregates(ir, catalog, sink);

  return sink.findings.sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    categoryOrder(a.category) - categoryOrder(b.category) ||
    a.id.localeCompare(b.id) ||
    a.evidence.sqlFragment.localeCompare(b.evidence.sqlFragment),
  );
}

// ---------------------------------------------------------------------------
// Correctness and intent gates
// ---------------------------------------------------------------------------

function detectNullableNotIn(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    for (const predicate of block.predicates) {
      if (
        predicate.kind !== 'subquery' ||
        !predicate.negated ||
        !/\bNOT\s+IN\s*\(/i.test(predicate.sql)
      ) continue;

      for (const childId of nestedBlockIds(predicate)) {
        const child = ir.blocks.find((candidate) => candidate.id === childId);
        const output = child?.projections[0]?.columns[0];
        if (!child || child.projections.length !== 1 || output?.nullable !== true) continue;

        const relation = output.table ?? relationSource(child, output.alias);
        const column = output.column;
        const table = relation ? findTable(catalog, relation) : undefined;
        const catalogColumn = relation ? findColumn(catalog, relation, column) : undefined;
        const nullFrac = catalogColumn?.stats?.nullFrac;
        const estimatedNulls = table?.rowCount !== undefined && nullFrac !== undefined
          ? table.rowCount * nullFrac
          : undefined;
        const nullEvidence = nullFrac !== undefined
          ? ` Catalog statistics report ${formatPercent(nullFrac)} NULL overall` +
            (estimatedNulls !== undefined ? ` (about ${formatRows(estimatedNulls)} of ${formatRows(table!.rowCount!)} rows)` : '') +
            ` for ${qualified(relation, column)}.`
          : ` The catalog declares ${qualified(relation, column)} nullable.`;

        addFinding(sink, {
          id: 'not-in-nullable-subquery',
          title: 'Nullable NOT IN subquery can invalidate anti-membership',
          severity: 'critical',
          category: 'correctness',
          actionability: 'required',
          evidence: {
            sqlFragment: predicate.sql,
            relation,
            column,
          },
          impact:
            `SQL NOT IN becomes UNKNOWN for every otherwise-unmatched outer row if this subquery emits even one NULL.` +
            `${nullEvidence} Because the IR cannot prove that the subquery filters every NULL out, the returned population is not trustworthy.`,
          remediation: 'Replace this with a null-safe correlated anti-membership test, normally NOT EXISTS.',
          caveat:
            'NOT IN is safe only when the outer comparison value and every value produced by the subquery are both proven non-NULL; filtering NULL inside the subquery preserves semantics but may not produce the same plan as NOT EXISTS.',
          confidence: nullFrac !== undefined && nullFrac > 0 ? 'high' : 'medium',
        });
      }
    }
  }
}

function detectAggregateFanOut(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    const affected: Array<{
      aggregateSql: string;
      aliases: string[];
      columns: ResolvedColumnRef[];
      culprit: QueryBlockIR['joins'][number];
    }> = [];

    for (const aggregate of block.aggregates) {
      if (aggregate.distinct || !DUPLICATE_SENSITIVE_AGGREGATES.has(aggregate.func.toLowerCase())) continue;
      const projection = block.projections.find((candidate) => sameSql(candidate.sql, aggregate.sql));
      if (!projection?.columns.length) continue; // count(*) can describe joined-row grain legitimately.

      const aliases = unique(
        projection.columns.map((column) => column.alias).filter((alias): alias is string => !!alias),
      );
      const culprit = block.joins.find((join) =>
        aliases.some((alias) => join.multipliedRelations?.includes(alias)),
      );
      if (!culprit) continue;
      affected.push({ aggregateSql: aggregate.sql, aliases, columns: projection.columns, culprit });
    }

    if (!affected.length) continue;
    const aggregateSql = affected.map((item) => item.aggregateSql).join(', ');
    const affectedAliases = unique(affected.flatMap((item) => item.aliases));
    const culprit = affected[0]!.culprit;
    const joinPredicate = joinEvidence(culprit);
    const joinedRelation = relationSource(block, culprit.rightRelation) ?? culprit.rightRelation;
    const joinedTable = findTable(catalog, joinedRelation);
    const firstKey = culprit.equiKeys.find((key) => key.right.alias === culprit.rightRelation)?.right ??
      culprit.equiKeys[0]?.right;
    const reason = sentence(culprit.fanOutReason);

    addFinding(sink, {
      id: 'aggregate-over-one-to-many-fanout',
      title: 'Join fan-out changes an aggregate computed at an earlier grain',
      severity: 'critical',
      category: 'correctness',
      actionability: 'required',
      evidence: {
        sqlFragment: joinPredicate ? `${aggregateSql}; ${joinPredicate}` : aggregateSql,
        relation: joinedRelation,
        column: firstKey?.column,
      },
      impact:
        `${aggregateSql} reads ${joinWords(affectedAliases)}, whose rows the join duplicates before aggregation.` +
        (joinedTable?.rowCount !== undefined
          ? ` The catalog estimates ${formatRows(joinedTable.rowCount)} rows in ${joinedRelation}.`
          : '') +
        (reason ? ` ${reason}` : '') +
        ' Duplicate-sensitive aggregates can therefore over-count or otherwise change values; this is a result-correctness problem before it is a performance problem.',
      remediation: 'Aggregate each measure at its natural grain before the multiplying join, or remove the join when it contributes no required value or filter.',
      caveat:
        'Do not flag a lookup join merely because some relation is repeated: the aggregate must read an alias named in multipliedRelations. MIN/MAX and item-grain measures are not changed by duplication in the same way, and SUM(DISTINCT ...) is not a general repair.',
      confidence: 'high',
    });
  }
}

function detectOuterJoinDemotions(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const demotion of outerJoinDemotions(ir)) {
    const relation = relationSource(ir.blocks.find((block) => block.id === demotion.blockId), demotion.relation) ??
      demotion.predicate.columns.find((column) => column.alias === demotion.relation)?.table ??
      demotion.relation;
    const table = findTable(catalog, relation);
    const column = demotion.predicate.columns.find((ref) =>
      ref.alias && demotion.relation.split(/\s*,\s*/).includes(ref.alias),
    )?.column;

    addFinding(sink, {
      id: `${demotion.join.type}-join-null-rejected-in-where`,
      title: 'WHERE predicate erases outer-join row preservation',
      severity: 'high',
      category: 'intent',
      actionability: 'required',
      evidence: {
        sqlFragment: demotion.predicate.sql,
        relation,
        column,
      },
      impact:
        `${demotion.join.type.toUpperCase()} JOIN can supply NULLs for ${demotion.relation}, but this WHERE predicate rejects every such row, so unmatched rows cannot appear.` +
        (table?.rowCount !== undefined ? ` The affected base relation has about ${formatRows(table.rowCount)} catalog-estimated rows.` : '') +
        ' PostgreSQL may optimize the shape as an inner join, so the concern is which population the author intended rather than an assumed slowdown.',
      remediation: 'Decide the intended population: move the condition into ON to preserve unmatched rows, or spell an inner join explicitly when only matches belong.',
      caveat:
        'If matched rows are the requirement, the current result population is intentional and only the misleading outer-join spelling needs cleanup; predicates proven NULL-tolerant are not reported.',
      confidence: 'high',
    });
  }
}

// ---------------------------------------------------------------------------
// Scaling shapes
// ---------------------------------------------------------------------------

function detectDeepOffsets(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    const offset = block.offset ?? 0;
    const threshold = Math.max(1_000, (block.limit ?? 100) * 10);
    if (offset < threshold) continue;
    const largest = largestRelation(block, catalog);
    const order = block.orderBy.map((item) => `${item.sql} ${item.direction.toUpperCase()}`).join(', ');
    const evidence = [
      order ? `ORDER BY ${order}` : undefined,
      block.limit !== undefined ? `LIMIT ${block.limit}` : undefined,
      `OFFSET ${offset}`,
    ].filter(Boolean).join(' ');

    addFinding(sink, {
      id: 'deep-offset-pagination',
      title: 'OFFSET makes page cost grow with page depth',
      severity: offset >= 10_000 ? 'high' : 'medium',
      category: 'performance',
      actionability: 'optional',
      evidence: {
        sqlFragment: evidence,
        relation: largest?.name,
        column: block.orderBy[0]?.column?.column,
      },
      impact:
        `The executor must produce and discard at least ${formatRows(offset)} ordered rows before returning this page.` +
        (largest?.rowCount !== undefined ? ` The largest input relation has about ${formatRows(largest.rowCount)} catalog-estimated rows.` : '') +
        ' Work grows linearly with page depth even when a matching ordering index exists.',
      remediation: 'Use cursor/seek pagination over the complete deterministic ordering when the product does not require arbitrary page jumps.',
      caveat: 'OFFSET remains appropriate for shallow pages or true random page access; seek pagination changes the API and its concurrent-update behavior.',
      confidence: 'high',
    });
  }
}

function detectRepeatedCorrelatedAggregates(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  const candidates = ir.blocks.filter((block) => block.correlated && block.aggregates.length > 0);
  const groups = new Map<string, QueryBlockIR[]>();
  for (const child of candidates) {
    const sources = unique(child.relations.map((relation) => relation.source)).sort();
    const refs = unique((child.correlationRefs ?? []).map((ref) =>
      `${ref.table ?? ref.alias ?? '?'}.${ref.column}`,
    )).sort();
    if (!sources.length || !refs.length) continue;
    const key = `${sources.join('+')}|${refs.join('+')}`;
    const group = groups.get(key) ?? [];
    group.push(child);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const usages = unique(group.flatMap((child) => subqueryUsages(ir, child.id)));
    if (usages.length < 2) continue;
    const outer = outerCardinality(ir, catalog, group[0]!.correlationRefs?.[0]);
    const sources = unique(group.flatMap((child) => child.relations.map((relation) => relation.source)));
    const severity = cardinalitySeverity(outer.rows, 'low');

    addFinding(sink, {
      id: 'repeated-correlated-aggregate-scans',
      title: 'Correlated aggregates repeat the same per-row lookup',
      severity,
      category: 'performance',
      actionability: 'optional',
      evidence: {
        sqlFragment: usages.join(', '),
        relation: sources[0],
        column: group[0]!.correlationRefs?.[0]?.column,
      },
      impact:
        `${group.length} correlated aggregate blocks read ${joinWords(sources)} for the same outer correlation key.` +
        cardinalityImpact(outer) +
        ' Each qualifying outer row can therefore repeat multiple parameterized lookups instead of computing the aggregates together.',
      remediation: 'Compute the related aggregates together while preserving the outer row and each aggregate\'s empty-input result.',
      caveat:
        'Correlation is not automatically slow: a selective outer input plus an index on the correlation key can beat pre-aggregating the entire inner table. Validate the alternative against the real plan.',
      confidence: outer.rows !== undefined ? 'high' : 'medium',
    });
  }
}

function detectCorrelatedTopPerGroup(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const child of ir.blocks) {
    if (!child.correlated || child.aggregates.length !== 1) continue;
    const aggregate = child.aggregates[0]!;
    if (!['max', 'min'].includes(aggregate.func.toLowerCase())) continue;

    for (const parent of ir.blocks) {
      for (const predicate of parent.predicates) {
        if (
          predicate.kind !== 'subquery' ||
          !nestedBlockIds(predicate).includes(child.id) ||
          !hasPlainEquality(predicate.sql)
        ) continue;
        const outerRef = child.correlationRefs?.[0];
        const outer = outerCardinality(ir, catalog, outerRef);
        const severity = cardinalitySeverity(outer.rows, 'medium');
        const innerRelation = child.relations[0]?.source;

        addFinding(sink, {
          id: 'full-cardinality-correlated-aggregate',
          title: 'Correlated extreme-value lookup scales with outer rows',
          severity,
          category: 'performance',
          actionability: 'optional',
          evidence: {
            sqlFragment: predicate.sql,
            relation: innerRelation,
            column: outerRef?.column,
          },
          impact:
            `The outer predicate compares each row with a correlated ${aggregate.func.toUpperCase()} result.` +
            cardinalityImpact(outer) +
            ' This shape can run the inner aggregate once per outer row, so work grows with outer rows multiplied by matching rows per correlation key.',
          remediation: 'Compute the per-group extreme setwise and make the desired behavior for equal extreme values explicit.',
          caveat:
            'The equality form returns every row tied for the extreme. DISTINCT ON, LIMIT 1, or row_number() changes results unless an accepted deterministic tie-break rule is supplied.',
          confidence: outer.rows !== undefined ? 'high' : 'medium',
        });
      }
    }
  }
}

function detectDistinctFanOut(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    if (!block.distinct || !block.joins.length) continue;
    const projectedAliases = new Set(
      block.projections.flatMap((projection) =>
        projection.columns.map((column) => column.alias).filter((alias): alias is string => !!alias),
      ),
    );
    if (!projectedAliases.size) continue;
    const multiplied = new Set(block.joins.flatMap((join) => join.multipliedRelations ?? []));
    const projectedAndMultiplied = [...projectedAliases].filter((alias) => multiplied.has(alias));
    const unprojectedJoinedSide = block.relations.some((relation) => !projectedAliases.has(relation.alias));
    if (!projectedAndMultiplied.length || !unprojectedJoinedSide) continue;

    const culprit = block.joins.find((join) =>
      projectedAndMultiplied.some((alias) => join.multipliedRelations?.includes(alias)),
    )!;
    const largest = largestRelation(block, catalog);

    addFinding(sink, {
      id: 'distinct-collapses-existence-fanout',
      title: 'DISTINCT collapses rows produced by an existence-only join',
      severity: largest?.rowCount !== undefined && largest.rowCount >= 1_000_000 ? 'medium' : 'low',
      category: 'performance',
      actionability: 'optional',
      evidence: {
        sqlFragment: `SELECT DISTINCT ${block.projections.map((projection) => projection.sql).join(', ')}; ${joinEvidence(culprit)}`,
        relation: largest?.name,
        column: culprit.equiKeys[0]?.left.column,
      },
      impact:
        `The query projects ${joinWords(projectedAndMultiplied)} but a joined side can multiply those rows before DISTINCT removes duplicates.` +
        (largest?.rowCount !== undefined ? ` The largest joined input has about ${formatRows(largest.rowCount)} catalog-estimated rows.` : '') +
        ' Work is proportional to matching join paths rather than only the requested output grain.',
      remediation: 'Use an existence/semi-join form when joined-side columns do not contribute to the result and only the presence of a match matters.',
      caveat:
        'DISTINCT can be intentional, and an EXISTS rewrite does not guarantee early exit or a faster plan. Preserve duplicate semantics and validate the complete access path.',
      confidence: 'high',
    });
  }
}

// ---------------------------------------------------------------------------
// Predicate access paths and aggregate resource observations
// ---------------------------------------------------------------------------

function detectPredicateAccessProblems(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    for (const predicate of block.predicates) {
      if (predicate.clause !== 'where') continue;

      const leadingWildcards = extractLeadingWildcardLikes(predicate.sql);
      if (leadingWildcards.length) {
        const refs = leadingWildcards.map((match) => refForIdentifier(predicate, match.identifier)).filter(Boolean) as ResolvedColumnRef[];
        const ref = refs[0] ?? predicate.columns[0];
        const table = ref?.table ? findTable(catalog, ref.table) : undefined;
        addFinding(sink, {
          id: 'leading-wildcard-like',
          title: 'Leading-wildcard search has no B-tree search prefix',
          severity: table?.rowCount !== undefined && table.rowCount >= 1_000_000 ? 'medium' : 'low',
          category: 'performance',
          actionability: 'optional',
          evidence: {
            sqlFragment: leadingWildcards.map((match) => match.fragment).join(' OR '),
            relation: ref?.table,
            column: ref?.column,
          },
          impact:
            `A pattern beginning with an unescaped wildcard provides no leading text range for an ordinary B-tree.` +
            (table?.rowCount !== undefined ? ` ${ref?.table} has about ${formatRows(table.rowCount)} catalog-estimated rows that may need evaluation.` : '') +
            ' Selectivity is unknown from the catalog, so this is a search-shape risk rather than proof that a new index will beat a scan.',
          remediation: 'Use a suffix/infix-capable search path only when real pattern selectivity makes it worthwhile.',
          caveat: 'Anchored prefix LIKE is different and can use a B-tree with a compatible collation or pattern operator class; a leading-wildcard literal that matches most rows is still scan-shaped by nature.',
          confidence: 'high',
        });

        if (/\bOR\b/i.test(predicate.sql) && predicate.columns.length > 1) {
          addFinding(sink, {
            id: 'mixed-access-paths-under-or',
            title: 'OR combines branches with different access-path needs',
            severity: 'info',
            category: 'performance',
            actionability: 'none',
            evidence: {
              sqlFragment: predicate.sql,
              relation: ref?.table,
            },
            impact:
              'At least one OR branch has no B-tree search prefix while another branch references a different search expression. One ordinary index cannot make the non-sargable branch disappear.',
            remediation: 'Treat the branches as separate access-path requirements and consider restructuring only after preserving duplicate and global ORDER BY/LIMIT semantics.',
            caveat: 'PostgreSQL can combine independently usable indexes with BitmapOr; OR is not inherently slow, and UNION is not automatically equivalent or faster.',
            confidence: 'high',
          });
        }
      }

      const ref = singleResolvedColumn(predicate);
      if (!ref || predicate.sargable) continue;
      if (isJsonScalarExtraction(predicate, ref)) {
        if (hasMatchingExpressionIndex(predicate, ref, catalog)) continue;
        const table = ref.table ? findTable(catalog, ref.table) : undefined;
        addFinding(sink, {
          id: 'unindexed-json-scalar-extraction',
          title: 'JSON scalar equality has no matching expression access path',
          severity: table?.rowCount !== undefined && table.rowCount >= 1_000_000 ? 'medium' : 'low',
          category: 'performance',
          actionability: 'optional',
          evidence: { sqlFragment: predicate.sql, relation: ref.table, column: ref.column },
          impact:
            `${predicate.sql} compares an extracted JSON scalar rather than the stored JSONB value.` +
            (table?.rowCount !== undefined ? ` ${ref.table} has about ${formatRows(table.rowCount)} catalog-estimated rows.` : '') +
            ' No catalogued index stores the exact extracted expression, so the predicate cannot directly become a B-tree index condition.',
          remediation: 'Expose the exact extracted value through a matching expression index or stored attribute when this is a recurring selective filter.',
          caveat: 'The extraction is indexable as an exact expression and is not intrinsically unsargable. A raw JSONB GIN index serves different operators, and adding one access path does not guarantee a faster plan when other filters remain unsupported.',
          confidence: 'high',
        });
        continue;
      }

      if (!isWrappedColumnPredicate(predicate) || hasMatchingExpressionIndex(predicate, ref, catalog)) continue;
      const cast = /\bcast\b|::|promotes the column|implicit/i.test(predicate.sargableReason ?? '') ||
        /::\s*[a-z]/i.test(predicate.sql);
      const table = ref.table ? findTable(catalog, ref.table) : undefined;
      const rawIndexes = table?.indexes.filter((index) =>
        index.columns[0]?.toLowerCase() === ref.column.toLowerCase() && !(index.expressions?.length),
      ) ?? [];

      addFinding(sink, {
        id: cast ? 'non-sargable-cast-on-column' : 'non-sargable-function-on-column',
        title: cast ? 'Cast on the filtered column blocks a raw-column range' : 'Function on the filtered column blocks a raw-column search',
        severity: table?.rowCount !== undefined && table.rowCount >= 100_000 ? 'medium' : 'low',
        category: 'performance',
        actionability: 'optional',
        evidence: { sqlFragment: predicate.sql, relation: ref.table, column: ref.column },
        impact:
          `${predicate.sql} compares a computed value instead of bare ${qualified(ref.table, ref.column)}, so an ordinary B-tree on the raw column cannot directly narrow it.` +
          (table?.rowCount !== undefined ? ` ${ref.table} has about ${formatRows(table.rowCount)} catalog-estimated rows.` : '') +
          (rawIndexes.length ? ` Existing raw-column index${rawIndexes.length === 1 ? '' : 'es'} (${rawIndexes.map((index) => index.name).join(', ')}) do not store this expression.` : '') +
          ' No matching expression index is present in the supplied catalog.',
        remediation: 'Express the filter on the raw column when equivalent, using explicit half-open boundaries for time ranges and an explicit intended time zone where relevant.',
        caveat:
          'An exactly matching immutable expression index can serve a wrapped predicate, and a scan may still be rational for a broad filter or small table. This finding predicts index eligibility, not a measured speedup.',
        confidence: 'high',
      });
    }
  }
}

function detectDistinctAggregates(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    for (const aggregate of block.aggregates) {
      if (!aggregate.distinct) continue;
      const largest = largestRelation(block, catalog);
      if (largest?.rowCount === undefined || largest.rowCount < 100_000) continue;
      const projection = block.projections.find((candidate) => sameSql(candidate.sql, aggregate.sql));
      const column = projection?.columns[0];
      addFinding(sink, {
        id: 'large-input-distinct-aggregate',
        title: 'DISTINCT aggregate must track per-group uniqueness',
        severity: largest.rowCount >= 1_000_000 ? 'low' : 'info',
        category: 'performance',
        actionability: 'none',
        evidence: {
          sqlFragment: aggregate.sql,
          relation: column?.table ?? largest.name,
          column: column?.column,
        },
        impact:
          `${aggregate.sql} requires PostgreSQL to retain or sort distinct values within each group. The largest input relation has about ${formatRows(largest.rowCount)} catalog-estimated rows, but the IR cannot predict post-filter cardinality or memory use, so this is a resource-risk observation rather than a diagnosed spill.`,
        remediation: 'Keep the distinct semantics unless the metric definition changes, and inspect a real plan to determine whether memory, sorting, or pre-aggregation needs attention.',
        caveat: 'COUNT(DISTINCT ...) is often exactly the required metric. Do not remove DISTINCT or claim a speedup from catalog size alone.',
        confidence: 'medium',
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Evidence helpers
// ---------------------------------------------------------------------------

function addFinding(sink: FindingSink, finding: Finding): void {
  const evidenceKey = `${finding.id}\u0000${finding.evidence.sqlFragment}\u0000${finding.evidence.relation ?? ''}\u0000${finding.evidence.column ?? ''}`;
  if (sink.evidenceKeys.has(evidenceKey)) return;
  sink.evidenceKeys.add(evidenceKey);

  const usedIds = new Set(sink.findings.map((candidate) => candidate.id));
  if (usedIds.has(finding.id)) {
    let suffix = 2;
    while (usedIds.has(`${finding.id}-${suffix}`)) suffix++;
    finding = { ...finding, id: `${finding.id}-${suffix}` };
  }
  sink.findings.push(finding);
}

function categoryOrder(category: Finding['category']): number {
  return category === 'correctness' ? 0 : category === 'intent' ? 1 : 2;
}

function relationSource(block: QueryBlockIR | undefined, alias: string | undefined): string | undefined {
  if (!block || !alias) return undefined;
  return block.relations.find((relation) => relation.alias === alias)?.source;
}

function singleResolvedColumn(predicate: Predicate): ResolvedColumnRef | undefined {
  const resolved = predicate.columns.filter((column) => !column.unresolved);
  if (resolved.length !== 1) return undefined;
  return resolved[0];
}

function joinEvidence(join: QueryBlockIR['joins'][number]): string {
  const keys = join.equiKeys.map((key) =>
    `${refSql(key.left)} = ${refSql(key.right)}`,
  );
  const residual = join.residualPredicates.map((predicate) => predicate.sql);
  return [...keys, ...residual].join(' AND ');
}

function refSql(ref: ResolvedColumnRef): string {
  return `${ref.alias ? `${ref.alias}.` : ''}${ref.column}`;
}

function qualified(relation: string | undefined, column: string): string {
  return relation ? `${relation}.${column}` : column;
}

function joinWords(values: string[]): string {
  if (values.length <= 1) return values[0] ?? 'the affected relation';
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function sameSql(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sentence(value: string | undefined): string {
  if (!value) return '';
  const clean = value.trim();
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

function formatRows(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value * 100 < 1 ? 2 : 1)}%`;
}

function largestRelation(block: QueryBlockIR, catalog: Catalog): { name: string; rowCount?: number } | undefined {
  const relations = block.relations.map((relation) => {
    const table = findTable(catalog, relation.source);
    return { name: relation.source, rowCount: table?.rowCount };
  });
  return relations.sort((a, b) => (b.rowCount ?? -1) - (a.rowCount ?? -1))[0];
}

function outerCardinality(ir: QueryIR, catalog: Catalog, ref: ResolvedColumnRef | undefined): OuterCardinality {
  if (!ref?.alias) return { exactForIr: false };
  for (const block of ir.blocks) {
    const relation = block.relations.find((candidate) => candidate.alias === ref.alias && (!ref.table || candidate.source === ref.table));
    if (!relation) continue;
    if (relation.estimatedRows !== undefined) {
      return { rows: relation.estimatedRows, exactForIr: true, relation: relation.source };
    }
    const independentPredicates = relation.localPredicates.filter((predicate) => predicate.kind !== 'subquery');
    if (!independentPredicates.length) {
      return { rows: findTable(catalog, relation.source)?.rowCount, exactForIr: true, relation: relation.source };
    }
    return { exactForIr: false, relation: relation.source };
  }
  return { exactForIr: false, relation: ref.table };
}

function cardinalityImpact(outer: OuterCardinality): string {
  if (outer.rows === undefined) {
    return ' The supplied catalog cannot establish how many outer rows qualify.';
  }
  const qualifier = outer.exactForIr ? 'IR/catalog estimate' : 'catalog upper bound';
  return ` The ${qualifier} is about ${formatRows(outer.rows)} outer rows${outer.relation ? ` from ${outer.relation}` : ''}.`;
}

function cardinalitySeverity(rows: number | undefined, fallback: Severity): Severity {
  if (rows === undefined) return fallback;
  if (rows >= 100_000) return 'high';
  if (rows >= 10_000) return 'medium';
  return 'low';
}

function subqueryUsages(ir: QueryIR, blockId: string): string[] {
  const usages: string[] = [];
  for (const block of ir.blocks) {
    for (const projection of block.projections) {
      if (nestedBlockIds(projection).includes(blockId)) usages.push(projection.sql);
    }
    for (const predicate of block.predicates) {
      if (nestedBlockIds(predicate).includes(blockId)) usages.push(predicate.sql);
    }
  }
  return usages;
}

function hasPlainEquality(sql: string): boolean {
  return /(^|[^<>!=])=([^=]|$)/.test(sql);
}

function isWrappedColumnPredicate(predicate: Predicate): boolean {
  if (!['equality', 'range', 'null-check'].includes(predicate.kind)) return false;
  const reason = (predicate.sargableReason ?? '').toLowerCase();
  return (
    reason.includes('wraps') ||
    reason.includes('computed value') ||
    reason.includes('cast to') ||
    reason.includes('promotes the column')
  );
}

function isJsonScalarExtraction(predicate: Predicate, ref: ResolvedColumnRef): boolean {
  return /jsonb/i.test(ref.dataType ?? '') && /(?:->>|#>>)/.test(predicate.sql);
}

function hasMatchingExpressionIndex(predicate: Predicate, ref: ResolvedColumnRef, catalog: Catalog): boolean {
  if (!ref.table) return false;
  const table = findTable(catalog, ref.table);
  if (!table) return false;
  const sql = canonicalExpression(predicate.sql);
  return table.indexes.some((index) =>
    (index.expressions ?? index.columns.filter((column) => /[()]/.test(column))).some((expression) => {
      const candidate = canonicalExpression(expression);
      return candidate.length >= 4 && sql.includes(candidate);
    }),
  );
}

function canonicalExpression(value: string): string {
  let result = value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\b[a-z_][a-z0-9_$]*\./g, '')
    // pg_get_indexdef often prints parser-inserted literal coercions that are
    // implicit in the author-written predicate (notably JSON ->> text keys).
    .replace(/('(?:''|[^'])*')::(?:text|varchar|bpchar)/g, '$1');
  // pg_get_indexdef commonly retains one extra pair around a bare argument.
  let previous = '';
  while (previous !== result) {
    previous = result;
    result = result.replace(/\(\(([a-z_][a-z0-9_$]*)\)\)/g, '($1)');
  }
  return stripBalancedOuterParens(result);
}

function stripBalancedOuterParens(value: string): string {
  let result = value;
  while (result.startsWith('(') && result.endsWith(')')) {
    let depth = 0;
    let enclosesWhole = true;
    let quoted = false;
    for (let i = 0; i < result.length; i++) {
      const ch = result[i]!;
      if (ch === "'") {
        if (quoted && result[i + 1] === "'") {
          i++;
          continue;
        }
        quoted = !quoted;
      }
      if (quoted) continue;
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0 && i < result.length - 1) {
        enclosesWhole = false;
        break;
      }
    }
    if (!enclosesWhole || depth !== 0) break;
    result = result.slice(1, -1);
  }
  return result;
}

function extractLeadingWildcardLikes(sql: string): LikeMatch[] {
  const matches: LikeMatch[] = [];
  const identifier = `(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)(?:\\.(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*))?`;
  const pattern = new RegExp(`(${identifier})\\s+(?:NOT\\s+)?(?:LIKE|ILIKE)\\s+(?:E)?'((?:''|[^'])*)'`, 'gi');
  for (const match of sql.matchAll(pattern)) {
    const literal = match[2] ?? '';
    if (!literal.startsWith('%') && !literal.startsWith('_')) continue;
    matches.push({ fragment: match[0], identifier: match[1]!, pattern: literal });
  }
  return matches;
}

function refForIdentifier(predicate: Predicate, identifier: string): ResolvedColumnRef | undefined {
  const parts = identifier.split('.').map((part) => part.replace(/^"|"$/g, '').replace(/""/g, '"'));
  const column = parts.at(-1)?.toLowerCase();
  const alias = parts.length > 1 ? parts.at(-2)?.toLowerCase() : undefined;
  return predicate.columns.find((ref) =>
    ref.column.toLowerCase() === column && (!alias || ref.alias?.toLowerCase() === alias),
  );
}
