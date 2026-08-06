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
import { orderingIsTotal as blockOrderingIsTotal } from '../explain/index.ts';
import { columnFixedByEquality, expressionFixedByEquality } from '../explain/index.ts';
import { nestedBlockIds, outerJoinDemotions } from '../ir/index.ts';
import { isInteger, isTexty, normalizeType } from '../ir/expressions.ts';
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

/**
 * Aggregates whose result changes when a join fans the input out.
 *
 * The test is whether feeding a row twice can change the answer. A fan-out does
 * not duplicate rows uniformly, so anything weighted by row count, order, or
 * distribution belongs here — not just the obvious additive ones.
 *
 * Deliberately excluded, because repeating a row cannot change their value:
 * `min`, `max`, `bool_and`, `bool_or`, `every`, `bit_and`, `bit_or`, and
 * `range_intersect_agg`. Each is idempotent — `x AND x = x`, `x & x = x`,
 * `max(a, a) = a` — so a fan-out inflates the row count without moving the
 * result, and flagging them would be a false positive.
 */
const DUPLICATE_SENSITIVE_AGGREGATES = new Set([
  // Additive and counting.
  'sum', 'avg', 'count',
  // Collecting: every duplicate becomes another element.
  'array_agg', 'string_agg', 'json_agg', 'jsonb_agg',
  'json_object_agg', 'jsonb_object_agg', 'xmlagg', 'range_agg',
  // Dispersion: weighted by how many rows carry each value.
  'stddev', 'stddev_pop', 'stddev_samp',
  'variance', 'var_pop', 'var_samp',
  // Regression and correlation: computed over row pairs.
  'corr', 'covar_pop', 'covar_samp',
  'regr_slope', 'regr_intercept', 'regr_count', 'regr_r2',
  'regr_avgx', 'regr_avgy', 'regr_sxx', 'regr_syy', 'regr_sxy',
  // Distribution: position and frequency both shift under uneven duplication.
  'percentile_cont', 'percentile_disc', 'mode',
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
  detectNullLiteralEquality(ir, catalog, sink);
  detectAggregateFanOut(ir, catalog, sink);
  detectCountNullableColumn(ir, catalog, sink);
  detectOuterJoinDemotions(ir, catalog, sink);
  detectDeepOffsets(ir, catalog, sink);
  detectLimitWithoutOrder(ir, catalog, sink);
  detectRepeatedCorrelatedAggregates(ir, catalog, sink);
  detectCorrelatedTopPerGroup(ir, catalog, sink);
  detectDistinctFanOut(ir, catalog, sink);
  detectPredicateAccessProblems(ir, catalog, sink);
  detectCrossTypeJoinKeys(ir, catalog, sink);
  detectDistinctAggregates(ir, catalog, sink);
  detectRedundantGroupBy(ir, catalog, sink);

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
      // A literal NULL in a NOT IN list is not a risk, it is a guarantee: every
      // comparison against NULL is UNKNOWN, so `x NOT IN (1, 2, NULL)` returns
      // no rows for any x, forever. The gate below only ever looked at subquery
      // operands, so this shape passed in silence.
      if (predicate.kind === 'in-list' && predicate.negated && listContainsNullLiteral(predicate.sql)) {
        const ref = singleResolvedColumn(predicate);
        addFinding(sink, {
          id: 'not-in-null-literal',
          title: 'NOT IN against a list containing NULL returns no rows',
          severity: 'critical',
          category: 'correctness',
          actionability: 'required',
          evidence: { sqlFragment: predicate.sql, relation: ref?.table, column: ref?.column },
          impact:
            `${predicate.sql} compares against a list containing a NULL literal. Every comparison with NULL is UNKNOWN, ` +
            'so NOT IN cannot be true for any row and this predicate eliminates the entire result — not just the listed values.',
          remediation:
            'Remove the NULL from the list, or express the intent as NOT EXISTS / a left-join anti-join if NULL was meant to represent a missing value.',
          caveat: 'IN (with a NULL in the list) is unaffected in the same way: it simply never matches the NULL entry.',
          confidence: 'high',
        });
      }

      if (
        predicate.kind !== 'subquery' ||
        !predicate.negated ||
        !/\bNOT\s+IN\s*\(/i.test(predicate.sql)
      ) continue;

      for (const childId of nestedBlockIds(predicate)) {
        const child = ir.blocks.find((candidate) => candidate.id === childId);
        const output = child?.projections[0]?.columns[0];
        if (!child || child.projections.length !== 1 || output?.nullable !== true) continue;
        // A catalog-nullable column is not a nullable *result* when the
        // subquery filters the NULLs out. `NOT IN (SELECT e.customer_id FROM
        // events e WHERE e.customer_id IS NOT NULL)` is exactly the repair this
        // finding asks for, and reporting it as the defect tells the reader to
        // fix something they have already fixed.
        if (subqueryExcludesNulls(child, output)) continue;

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

/**
 * Detect `col = NULL` and `col <> NULL` / `col != NULL` — the classic
 * three-valued-logic trap.
 *
 * A bare `= NULL` is never true (it evaluates to UNKNOWN), so the predicate
 * removes every row; `<> NULL` / `!= NULL` is likewise never true and drops the
 * column's NULL rows from what the author usually meant as "non-null rows."
 * PostgreSQL accepts the syntax, so the bug is silent. `IS NULL` / `IS NOT
 * NULL` are the null-aware forms.
 *
 * The engine already classifies these as plain `equality` (op `=`, with
 * `negated` for `<>`/`!=`) because `classify()` never inspects whether the
 * constant side is a NULL literal. This detector scans the predicate SQL with
 * quote-awareness — the same approach `listContainsNullLiteral` takes — so a
 * quoted `'NULL'` string and a NULL inside an `IN`-list are not mistaken for
 * the keyword.
 */
function detectNullLiteralEquality(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    for (const predicate of block.predicates) {
      if (predicate.kind !== 'equality') continue;
      const op = bareNullEquality(predicate.sql);
      if (!op) continue;
      const ref = singleResolvedColumn(predicate);
      const negated = op !== '=';
      addFinding(sink, {
        id: 'null-literal-equality',
        title: negated
          ? 'Comparison against NULL is never true and drops NULL rows'
          : 'Equality against NULL is never true and returns no rows',
        severity: 'critical',
        category: 'correctness',
        actionability: 'required',
        evidence: { sqlFragment: predicate.sql, relation: ref?.table, column: ref?.column },
        impact:
          `${predicate.sql} compares a column with the NULL keyword using ${op}. Every comparison with NULL ` +
          'evaluates to UNKNOWN, which is not true, so this predicate ' +
          (negated
            ? 'drops every row — including the NULL rows an inequality was usually meant to keep separate from the non-NULL ones.'
            : 'can never be satisfied and eliminates the entire result set.'),
        remediation: negated
          ? "Rewrite as `IS NOT NULL` to select non-NULL rows, or `IS DISTINCT FROM <value>` for a true null-aware inequality. `<> NULL` cannot express either intent."
          : 'Rewrite as `IS NULL` to test for NULL. `= NULL` can never match.',
        caveat:
          'A quoted \'NULL\' string literal is an ordinary value and is not reported; only a bare NULL keyword is. IS [NOT] DISTINCT FROM is the fully null-aware equality/inequality.',
        confidence: 'high',
      });
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

/**
 * Detect `count(col)` over a nullable column whose row is preserved by an
 * outer join. `count(col)` skips NULLs, so when the counted column's relation
 * is the null-extended side of a LEFT/FULL join, the preserved rows that failed
 * to match contribute NULL and are silently dropped from the count — the author
 * usually meant `count(*)` (all preserved rows) or a filter-and-inner-join.
 *
 * `count(*)` is unaffected (it counts rows, not values), `count(distinct col)`
 * has its own documented NULL semantics, and a NOT NULL column cannot be
 * null-extended to NULL, so none of those fire.
 */
function detectCountNullableColumn(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    for (const aggregate of block.aggregates) {
      if (aggregate.func.toLowerCase() !== 'count') continue;
      if (aggregate.distinct) continue;
      const projection = block.projections.find((candidate) => sameSql(candidate.sql, aggregate.sql));
      // count(*) has no column refs and counts rows; only a single-column count
      // is the nullable-skipping shape.
      if (!projection || projection.columns.length !== 1) continue;
      const ref = projection.columns[0]!;
      if (ref.unresolved) continue;
      const table = relationSource(block, ref.alias ?? ref.table) ?? ref.table;
      if (!table) continue;
      const catalogColumn = findColumn(catalog, table, ref.column);
      // Prefer the catalog's nullability; fall back to the resolved ref's.
      const nullable = catalogColumn ? catalogColumn.nullable : ref.nullable;
      if (!nullable) continue;

      // Is the counted column's relation the null-extended side of an outer join?
      const alias = ref.alias ?? ref.table;
      const outerJoin = block.joins.find((join) => {
        if (join.type === 'left') return join.rightRelation === alias;
        if (join.type === 'right') return join.leftRelation === alias;
        if (join.type === 'full') return join.leftRelation === alias || join.rightRelation === alias;
        return false;
      });
      if (!outerJoin) continue;

      const joinedRelation = relationSource(block, outerJoin.rightRelation) ?? outerJoin.rightRelation;
      addFinding(sink, {
        id: 'count-skips-nullable-rows',
        title: 'count(col) over a nullable outer-joined column drops unmatched rows',
        severity: 'high',
        category: 'correctness',
        actionability: 'optional',
        evidence: {
          sqlFragment: aggregate.sql,
          relation: table,
          column: ref.column,
        },
        impact:
          `count(${ref.column}) skips NULL values, and ${alias}.${ref.column} is nullable on the null-extended side of a ${outerJoin.type.toUpperCase()} join. ` +
          `Preserved rows that found no match contribute a NULL for ${ref.column} and are silently excluded from the count. ` +
          `count(*) would count every preserved row; the current count counts only matched ones.`,
        remediation:
          `If every preserved row should be counted, use count(*) (or count(a non-null key from the preserved side). ` +
          `If only matched rows should be counted, the outer join is probably not what was intended — an inner join would express that without a silent NULL filter.`,
        caveat:
          `count(col) is sometimes the deliberate "count of non-null values" metric. The finding fires only when the column is catalog-nullable AND its relation is outer-join-preserved, which is the shape where the skip is usually unintentional.`,
        confidence: 'high',
      });
    }
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
    const ordering = pagingOrderAssessment(block, catalog);
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
        `The executor must produce and discard at least ${formatRows(offset)} ${order ? 'ordered ' : ''}rows before returning this page.` +
        (largest?.rowCount !== undefined ? ` The largest input relation has about ${formatRows(largest.rowCount)} catalog-estimated rows.` : '') +
        ' Work grows linearly with page depth even when a matching ordering index exists.' +
        ordering.impact,
      remediation: ordering.remediation,
      caveat: 'OFFSET remains appropriate for shallow pages or true random page access; seek pagination changes the API and its concurrent-update behavior.',
      confidence: 'high',
    });
  }
}

/**
 * Detect `LIMIT` without a total `ORDER BY`.
 *
 * A `LIMIT` over an unspecified or non-unique ordering returns an unspecified
 * row set: re-runs, plan changes, or vacuum/analyze can return different rows
 * even on identical data. The explain layer already emits a caveat for the same
 * condition; this finding promotes it to an actionable correctness/intent
 * defect so it is not buried in prose. The total-order test is shared with the
 * explain layer (`orderingIsTotal`) so the two never disagree.
 *
 * No rewrite is emitted: a deterministic ordering is a semantic choice the tool
 * will not invent, mirroring the deliberate refusal to rewrite outer-join
 * demotions.
 */
function detectLimitWithoutOrder(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    if (block.limit === undefined) continue;
    const hasOrderBy = block.orderBy.length > 0;
    if (hasOrderBy && blockOrderingIsTotal(block, catalog)) continue;

    const order = block.orderBy.map((item) => `${item.sql} ${item.direction.toUpperCase()}`).join(', ');
    const evidence = [
      order ? `ORDER BY ${order}` : undefined,
      `LIMIT ${block.limit}`,
      block.offset !== undefined ? `OFFSET ${block.offset}` : undefined,
    ].filter(Boolean).join(' ');

    if (!hasOrderBy) {
      addFinding(sink, {
        id: 'limit-without-total-order',
        title: 'LIMIT with no ORDER BY returns a nondeterministic row set',
        severity: 'high',
        category: 'correctness',
        actionability: 'required',
        evidence: {
          sqlFragment: evidence,
          relation: largestRelation(block, catalog)?.name,
        },
        impact:
          'LIMIT without ORDER BY returns an unspecified subset of rows. The executor is free to return any rows it reaches first, so re-runs, plan changes, or VACUUM/ANALYZE can return a different set even on identical data. The result is not reproducible.',
        remediation:
          'Add a deterministic ORDER BY whose key is unique over the input (a primary key is a safe tiebreaker). Without one the LIMIT is a random sample, not a query.',
        caveat:
          'If an unspecified sample is genuinely intended, prefer TABLESAMPLE or an explicit random() for clarity rather than relying on the absence of ORDER BY.',
        confidence: 'high',
      });
      continue;
    }

    addFinding(sink, {
      id: 'limit-without-total-order',
      title: 'LIMIT with a non-unique ORDER BY can return different rows on ties',
      severity: 'medium',
      category: 'intent',
      actionability: 'optional',
      evidence: {
        sqlFragment: evidence,
        relation: largestRelation(block, catalog)?.name,
        column: block.orderBy[block.orderBy.length - 1]?.column?.column,
      },
      impact:
        'The ORDER BY key is not unique over the output, so rows tied at the LIMIT boundary are returned in an unspecified order. A different plan, a VACUUM/ANALYZE, or concurrent writes can swap which tied rows survive the cut, making the result non-reproducible at the margin.',
      remediation:
        'Extend ORDER BY with a unique tiebreaker (a primary key or other NOT NULL unique column) so the ordering is total. The current ordering is fine for "top N roughly" but not for reproducible pagination or stable sampling.',
      caveat:
        'A non-total ORDER BY is sometimes acceptable (e.g. dashboards showing "recent" rows). Promote to a total order only when the row set must be stable.',
      confidence: 'high',
    });
  }
}

/**
 * True when a bare `NULL` keyword appears in the predicate's value list.
 *
 * Quoted runs are skipped so the string `'NULL'`, which is an ordinary value,
 * is not mistaken for the keyword.
 */
function listContainsNullLiteral(sql: string): boolean {
  const bare = stripQuotedRuns(sql);
  return /\bNULL\b/i.test(bare.slice(bare.indexOf('(') + 1));
}

/**
 * Replace every single- and double-quoted run with a space, so a quoted `'NULL'`
 * string or an identifier containing the letters NULL cannot be mistaken for
 * the bare NULL keyword. Doubled quotes inside a literal (`'a''b'`) are honoured.
 */
export function stripQuotedRuns(sql: string): string {
  let bare = '';
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          break;
        }
        i++;
      }
      bare += ' ';
      continue;
    }
    bare += ch;
  }
  return bare;
}

/**
 * Returns the comparison operator (`=`, `<>`, or `!=`) when a predicate is a
 * direct column-versus-NULL comparison with a *bare* NULL keyword on the
 * constant side, otherwise undefined.
 *
 * `col = NULL`, `NULL = col`, `col <> NULL`, and `col != NULL` all match. A
 * quoted `'NULL'` does not, nor does a NULL inside parentheses — `IN (NULL)`
 * and `= ANY(NULL)` belong to other findings or are out of scope here. The
 * NULL must be the whole constant side (`col = NULL`), not part of an
 * expression (`col = NULL + 1` is not a null comparison).
 */
export function bareNullEquality(sql: string): '=' | '<>' | '!=' | undefined {
  const bare = stripQuotedRuns(sql);
  // Reject any parenthesised NULL: `IN (NULL)`, `= ANY(NULL)`, etc.
  if (/\(\s*NULL\s*\)/i.test(bare)) return undefined;
  // `col <op> NULL` at end of the predicate, or `NULL <op> col` at start.
  const trailing = /(?:=|<>|!=)\s+NULL\s*$/i.exec(bare);
  const leading = /^\s*NULL\s+(?:=|<>|!=)/i.exec(bare);
  const match = trailing ?? leading;
  if (!match) return undefined;
  const opMatch = /=|<>|!=/.exec(match[0])!;
  return opMatch[0] as '=' | '<>' | '!=';
}

/**
 * True when the subquery cannot emit NULL for its output column, because a
 * `WHERE ... IS NOT NULL` on that exact column removes them first.
 *
 * Only a non-negated `null-check` on the output column counts. An `IS NULL`
 * test, or one on a different column, proves nothing about this one.
 */
function subqueryExcludesNulls(child: QueryBlockIR, output: ResolvedColumnRef): boolean {
  return child.predicates.some((predicate) =>
    predicate.clause === 'where' &&
    predicate.kind === 'null-check' &&
    predicate.negated === true && // `IS NOT NULL` is the negated null-check
    predicate.columns.length === 1 &&
    predicate.columns[0]!.column === output.column &&
    (predicate.columns[0]!.alias ?? '') === (output.alias ?? ''),
  );
}

/**
 * What the block's ordering permits us to say about paging.
 *
 * Seek pagination needs a *total* order: without one there is no cursor to
 * carry. The finding used to assert "discard N ordered rows" and prescribe
 * "cursor/seek pagination over the complete deterministic ordering" whatever
 * the query said — including for `OFFSET 100000` with no `ORDER BY` at all,
 * where neither the ordered rows nor the deterministic ordering exist.
 *
 * Without any ordering the deeper problem is not cost: `LIMIT/OFFSET` over an
 * unordered result may return rows that overlap or skip between pages, and can
 * differ run to run. That is a correctness issue and the finding said nothing
 * about it.
 */
function pagingOrderAssessment(
  block: QueryBlockIR,
  catalog: Catalog,
): { impact: string; remediation: string } {
  if (!block.orderBy.length) {
    return {
      impact:
        ' This block has no ORDER BY, so the rows being skipped are not in any promised order:' +
        ' PostgreSQL may return overlapping or missing rows across pages, and a different set on a rerun.',
      remediation:
        'Add a deterministic ORDER BY before treating this as pagination at all — without one the page boundaries are not' +
        ' reproducible. Seek pagination then becomes possible over that ordering; it cannot be applied to an unordered result.',
    };
  }

  const refs = block.orderBy.map((item) => item.column);
  const table = refs[0]?.table;
  const total = !!table
    && refs.every((ref) => ref && ref.table === table && !ref.unresolved)
    && orderingIsTotal(catalog, table, refs.map((ref) => ref!.column));
  if (total) {
    return {
      impact: '',
      remediation:
        'Use cursor/seek pagination over the complete deterministic ordering when the product does not require arbitrary page jumps.',
    };
  }
  return {
    impact:
      ' The ORDER BY is not proven unique, so it does not define a total order: rows sharing a key can be' +
      ' returned in a different arrangement between pages, and no single cursor value identifies a boundary.',
    remediation:
      'Extend the ORDER BY with a tiebreaker that makes it unique (a primary key works), then use cursor/seek pagination' +
      ' over that complete ordering. A seek cursor cannot be formed while the ordering has ties.',
  };
}

/** True when some declared key proves the ordering columns identify a row. */
function orderingIsTotal(catalog: Catalog, tableName: string, columns: string[]): boolean {
  const table = findTable(catalog, tableName);
  if (!table) return false;
  const covers = (key: string[] | undefined) => !!key?.length && key.every((column) => columns.includes(column));
  return covers(table.primaryKey) || table.indexes.some((index) => index.unique && !index.where && covers(index.columns));
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

/**
 * Detect cross-type join keys: an equality between columns whose normalized
 * types differ, or whose join predicate carries an explicit cast on one side.
 *
 * A btree index is typed: it cannot serve an equality between, say, a text
 * column and an integer column without a cast, and the cast may force a
 * sequential scan or raise 'operator does not exist'. The same family with an
 * explicit cast (e.g. `o.code::text = p.code`) is the milder index-blocking
 * shape; a different-family match is the stronger one.
 *
 * Finding only — the assessor's sargability verdict is intentionally left
 * untouched (see plan #5). The finding's prose notes that an ordinary btree
 * cannot serve a cross-type equality without a cast, which supersedes the
 * sargability verdict in the report. No rewrite: choosing the cast direction
 * is a data/type decision the tool will not make.
 */
function detectCrossTypeJoinKeys(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    for (const join of block.joins) {
      for (const key of join.equiKeys) {
        const leftType = key.left.dataType;
        const rightType = key.right.dataType;
        if (!leftType || !rightType) continue;
        const leftNorm = normalizeType(leftType);
        const rightNorm = normalizeType(rightType);
        if (leftNorm === rightNorm) continue;

        const leftFamily = typeFamily(leftType);
        const rightFamily = typeFamily(rightType);
        const familyMismatch = leftFamily !== rightFamily;
        // An explicit cast on the join key (e.g. o.code::text = p.code) is the
        // same-family-but-cast shape; a family mismatch is the stronger case.
        const joinSql = joinEvidence(join);
        const castOnKey = /::\s*[a-z][a-z0-9_]*\b/i.test(joinSql);

        addFinding(sink, {
          id: 'cross-type-join-key',
          title: 'Join key compares columns of different types',
          severity: familyMismatch ? 'medium' : 'low',
          category: 'performance',
          actionability: 'optional',
          evidence: {
            sqlFragment: `${refSql(key.left)} = ${refSql(key.right)}`,
            relation: relationSource(block, key.right.alias ?? key.right.table) ?? key.right.table,
            column: key.right.column,
          },
          impact:
            `The join equality compares ${refSql(key.left)} (${leftType}) with ${refSql(key.right)} (${rightType}). ` +
            (familyMismatch
              ? 'The types are in different families, so PostgreSQL must coerce one side before comparing; an ordinary btree index on either key cannot serve the equality without a matching cast, and the comparison may raise "operator does not exist" if no implicit cast is available. '
              : 'The types differ in width or form within the same family; an explicit cast or a mismatched index type can still block index use. ') +
            'This is an index-blocking condition before it is a correctness one.',
          remediation:
            'Make the join key types agree at the source (a generated column or a typed expression index matching the comparison form), or cast consistently and index the cast expression. Pick the cast direction that matches the dominant filter.',
          caveat:
            castOnKey
              ? 'An explicit cast is already present on the join key; ensure an expression index matches the cast exactly, or remove the cast by aligning column types.'
              : 'No explicit cast is visible in the join predicate; PostgreSQL may apply an implicit coercion whose direction is version- and search_path-dependent.',
          confidence: 'high',
        });
      }
    }
  }
}

function typeFamily(t: string): string {
  if (isInteger(t)) return 'integer';
  if (isTexty(t)) return 'text';
  if (normalizeType(t) === 'jsonb' || normalizeType(t) === 'json') return 'json';
  if (normalizeType(t) === 'boolean') return 'boolean';
  if (normalizeType(t) === 'uuid') return 'uuid';
  if (/\btimestamp|date|time\b/.test(normalizeType(t))) return 'temporal';
  if (/\bnumeric|decimal|float|double|real\b/.test(normalizeType(t))) return 'numeric';
  return 'other';
}

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

/**
 * Detect `GROUP BY` whose every key is pinned to a single constant by an
 * equality in WHERE. The grouping cannot change the result — there is at most
 * one group — so the GROUP BY only adds a sort/hash-aggregate step.
 *
 * The fixed-by-equality proof is shared with the explain layer's grain prose
 * (`expressionFixedByEquality` / `columnFixedByEquality`), so the detector and
 * the explain text agree about when a group key is constant.
 *
 * No rewrite: collapsing the GROUP BY also requires dropping the aggregates or
 * wrapping them differently, which is a semantic choice the tool will not make
 * automatically. The finding points at the redundancy; the author decides.
 */
function detectRedundantGroupBy(ir: QueryIR, catalog: Catalog, sink: FindingSink): void {
  for (const block of ir.blocks) {
    const labelOf = (column: ResolvedColumnRef): string =>
      `${column.alias ?? column.table ?? '?'}.${column.column}`;
    const groups = block.groupByExpressions?.length
      ? block.groupByExpressions
      : block.groupBy.map((column) => ({ sql: labelOf(column), columns: [column] }));
    if (!groups.length) continue;
    const fixed = groups.every((group) =>
      expressionFixedByEquality(block, group.sql)
      || (group.columns.length === 1 && columnFixedByEquality(block, group.columns[0]!))
    );
    if (!fixed) continue;
    const groupSql = block.groupByExpressions?.length
      ? `GROUP BY ${block.groupByExpressions.map((g) => g.sql).join(', ')}`
      : `GROUP BY ${block.groupBy.map(labelOf).join(', ')}`;
    addFinding(sink, {
      id: 'redundant-group-by',
      title: 'GROUP BY a key already pinned to one value by WHERE',
      severity: 'low',
      category: 'performance',
      actionability: 'optional',
      evidence: {
        sqlFragment: groupSql,
        relation: largestRelation(block, catalog)?.name,
      },
      impact:
        'Every group key is fixed to a single constant by equality predicates in WHERE, so the input can contain at most one group. The GROUP BY cannot change the result; it only forces a sort or hash-aggregate step the executor cannot skip.',
      remediation:
        'If the aggregates are still wanted as single-row totals, the GROUP BY can be dropped (the aggregates become scalar over the filtered input). If the pinned key is meant to be a real grouping dimension, move or relax the equality that pins it.',
      caveat:
        'Removing GROUP BY changes the shape only if combined with dropping aggregates that reference the grouping. Verify the query still returns one row of totals before relying on this.',
      confidence: 'high',
    });
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
