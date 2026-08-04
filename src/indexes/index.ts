/** M5 — conservative, catalog-aware PostgreSQL index recommendations. */

import {
  indexDefinitionAdviceId,
  keySql,
  physicalIndexName,
  qualifiedTable,
  quoteIdentifier,
  removeQualifier,
  type AdviceIndexDefinition,
} from '../advice/definitions.ts';
import { findColumn, findTable } from '../catalog.ts';
import { nestedBlockIds } from '../ir/index.ts';
import type {
  Catalog,
  Finding,
  IndexRecommendation,
  Predicate,
  QueryBlockIR,
  QueryIR,
  ResolvedColumnRef,
  Table,
} from '../types.ts';

interface RecommendationSpec extends AdviceIndexDefinition {
  rationale: string;
  serves: string[];
  expectedEffect: string;
  priority: 1 | 2 | 3;
  confidence: IndexRecommendation['confidence'];
  withOptions?: string;
  costScope?: string;
}

/** Recommend only indexes supported by a concrete M4 finding and catalog facts. */
export function recommendIndexes(
  ir: QueryIR,
  catalog: Catalog,
  findings: Finding[],
): IndexRecommendation[] {
  const specs: RecommendationSpec[] = [];
  const root = ir.blocks.find((block) => block.id === ir.rootBlockId);
  if (!root) return [];

  if (hasFinding(findings, 'non-sargable-function-on-column')) {
    const spec = rawMonthRangeIndex(ir, catalog, root, findings);
    if (spec) specs.push(spec);
  }
  if (hasFinding(findings, 'repeated-correlated-aggregate-scans')) {
    specs.push(...correlatedAggregateIndexes(ir, catalog, root));
  }
  if (hasFinding(findings, 'deep-offset-pagination')) {
    const spec = keysetIndex(catalog, root);
    if (spec) specs.push(spec);
  }
  if (hasFinding(findings, 'not-in-nullable-subquery')) {
    const spec = nullableAntiJoinIndex(ir, root);
    if (spec) specs.push(spec);
  }
  // Aggregate-grain correctness defects are deliberately index-free: an index
  // cannot restore grain. Outer-join intent defects are likewise gated until a
  // human chooses the desired population.
  if (hasFinding(findings, 'distinct-collapses-existence-fanout')) {
    specs.push(...existenceJoinIndexes(root));
  }
  if (hasFinding(findings, 'non-sargable-cast-on-column')) {
    const spec = rawCastRangeIndex(catalog, root, findings);
    if (spec) specs.push(spec);
  }
  if (hasFinding(findings, 'full-cardinality-correlated-aggregate')) {
    const spec = topPerGroupIndex(ir, catalog, root);
    if (spec) specs.push(spec);
  }
  if (hasFinding(findings, 'unindexed-json-scalar-extraction')) {
    const spec = jsonScalarIndex(root, findings);
    if (spec) specs.push(spec);
  }

  const seen = new Set<string>();
  return specs
    .map((spec) => materializeRecommendation(catalog, spec))
    .filter((recommendation): recommendation is IndexRecommendation => !!recommendation)
    .filter((recommendation) => {
      if (seen.has(recommendation.id)) return false;
      seen.add(recommendation.id);
      return true;
    })
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

// ---------------------------------------------------------------------------
// Rule-specific definitions
// ---------------------------------------------------------------------------

function rawMonthRangeIndex(
  _ir: QueryIR,
  catalog: Catalog,
  block: QueryBlockIR,
  findings: Finding[],
): RecommendationSpec | undefined {
  const finding = firstFinding(findings, 'non-sargable-function-on-column');
  const predicate = predicateForFinding(block, finding);
  const ref = predicate && singleColumn(predicate);
  if (!predicate || !ref?.alias || !ref.table || !isMonthDateTrunc(predicate.sql)) return undefined;
  const table = findTable(catalog, ref.table);
  if (!table || (table.rowCount ?? 0) < 10_000) return undefined;

  const equalities = literalEqualities(block, ref.alias).filter((candidate) =>
    candidate.column.column !== ref.column && (candidate.predicate.selectivity ?? 1) <= 0.95,
  );
  const keys = [...equalities.map((candidate) => candidate.column.column), ref.column];
  const include = payloadColumns(block, catalog, ref.alias, keys, 3, ref.table);
  return {
    purpose: 'raw-range-cover',
    table: ref.table,
    keys,
    include,
    method: 'btree',
    rationale:
      `${equalities.length ? `${equalities.map((item) => item.column.column).join(', ')} ${equalities.length === 1 ? 'is an equality key and leads' : 'are equality keys and lead'}; ` : ''}` +
      `${ref.column} is the first range key. ${include.length ? `${include.join(', ')} are payload only for projection, joins, or aggregation.` : 'No payload columns are included.'}`,
    serves: [
      `The M6 half-open raw-column range replacing ${predicate.sql}`,
      ...equalities.map((item) => item.predicate.sql),
    ],
    expectedEffect:
      `Predicted/unverified: this index has no useful effect while ${ref.column} remains wrapped. It is explicitly coupled to the M6 half-open rewrite, after which PostgreSQL can bound the scan by equality keys followed by the raw range.`,
    priority: 1,
    confidence: 'high',
    costScope: 'rewrite-coupled covering index',
  };
}

function correlatedAggregateIndexes(
  ir: QueryIR,
  catalog: Catalog,
  root: QueryBlockIR,
): RecommendationSpec[] {
  const specs: RecommendationSpec[] = [];
  const children = ir.blocks.filter((block) => block.correlated && block.aggregates.length > 0);
  if (children.length < 2) return specs;
  const outerRef = children[0]!.correlationRefs?.[0];
  const outerRelation = root.relations.find((relation) => relation.alias === outerRef?.alias);
  if (outerRef?.alias && outerRef.table && outerRelation) {
    const table = findTable(catalog, outerRef.table);
    const selective = root.predicates.find((predicate) =>
      predicate.clause === 'where' &&
      predicate.kind === 'equality' &&
      predicate.selectivity !== undefined &&
      predicate.selectivity <= 0.1 &&
      predicate.columns.some((column) => column.alias === outerRef.alias) &&
      !/\$\d+/.test(predicate.sql),
    );
    if (table && selective) {
      const include = payloadColumns(root, catalog, outerRef.alias, [outerRef.column], 2, outerRef.table);
      specs.push({
        purpose: 'selective-driver-partial-cover',
        table: outerRef.table,
        keys: [outerRef.column],
        include,
        method: 'btree',
        where: removeQualifier(selective.sql, outerRef.alias),
        rationale:
          `The partial predicate performs the selective ${selective.sql} restriction; ${outerRef.column} is the correlation key.` +
          (include.length ? ` ${include.join(', ')} are output payload only.` : ''),
        serves: [selective.sql, `Outer correlation on ${refSql(outerRef)}`],
        expectedEffect:
          `Predicted/unverified: scan only the catalog-estimated selective driver subset (${formatSelectivity(selective.selectivity)}) and supply the correlation key without indexing the other rows.`,
        priority: 3,
        confidence: 'medium',
        costScope: 'selective partial driver index',
      });
    }
  }

  const extremeChild = children.find((child) =>
    child.aggregates.some((aggregate) => ['max', 'min'].includes(aggregate.func.toLowerCase())),
  );
  const extreme = extremeChild?.aggregates.find((aggregate) => ['max', 'min'].includes(aggregate.func.toLowerCase()));
  const innerRef = extremeChild && innerCorrelationRef(extremeChild);
  const extremeProjection = extremeChild?.projections.find((projection) => projection.sql === extreme?.sql);
  const extremeRef = extremeProjection?.columns[0];
  const innerRelation = extremeChild?.relations.find((relation) => relation.alias === innerRef?.alias);
  if (extremeChild && extreme && innerRef && extremeRef && innerRelation?.source) {
    specs.push({
      purpose: 'correlated-extreme-probe',
      table: innerRelation.source,
      keys: [innerRef.column, `${extremeRef.column} ${extreme.func.toLowerCase() === 'max' ? 'DESC' : 'ASC'}`],
      method: 'btree',
      rationale:
        `${innerRef.column} is the correlated equality key; ${extremeRef.column} is ordered ${extreme.func.toLowerCase() === 'max' ? 'descending for MAX' : 'ascending for MIN'} so the extreme can be found at the first matching entry.`,
      serves: children.flatMap((child) => child.predicates.filter((predicate) => predicate.clause === 'where').map((predicate) => predicate.sql)),
      expectedEffect:
        'Predicted/unverified: make the extreme-value probe stop at the first entry. The existing equality-leading index may already make the small correlated scans cheap, so this is optional unless the query is frequent.',
      priority: 3,
      confidence: 'medium',
      costScope: 'optional correlated-probe index',
    });
  }
  return specs;
}

function keysetIndex(catalog: Catalog, block: QueryBlockIR): RecommendationSpec | undefined {
  if (block.offset === undefined || block.orderBy.length < 2) return undefined;
  const orderedRefs = block.orderBy.map((order) => order.column).filter((ref): ref is ResolvedColumnRef => !!ref);
  if (orderedRefs.length !== block.orderBy.length) return undefined;
  const alias = orderedRefs[0]!.alias;
  const tableName = orderedRefs[0]!.table;
  if (!alias || !tableName || orderedRefs.some((ref) => ref.alias !== alias || ref.table !== tableName)) return undefined;
  const directions = new Set(block.orderBy.map((order) => order.direction));
  if (directions.size !== 1 || !orderingIsUnique(catalog, tableName, orderedRefs.map((ref) => ref.column))) return undefined;

  const equalities = literalEqualities(block, alias).filter((candidate) =>
    !orderedRefs.some((ref) => ref.column === candidate.column.column),
  );
  const keys = [
    ...equalities.map((candidate) => candidate.column.column),
    ...block.orderBy.map((order) => `${order.column!.column} ${order.direction.toUpperCase()}`),
  ];
  const include = payloadColumns(block, catalog, alias, keys, 3, tableName);
  return {
    purpose: 'keyset-cover',
    table: tableName,
    keys,
    include,
    method: 'btree',
    rationale:
      `${equalities.length ? `${equalities.map((item) => item.column.column).join(', ')} leads as the equality prefix; ` : ''}` +
      `${block.orderBy.map((order) => `${order.column!.column} ${order.direction.toUpperCase()}`).join(', ')} remain key columns because they define both ordering and the row-value cursor. ` +
      `${include.length ? `${include.join(', ')} are payload only.` : ''}`,
    serves: [
      ...equalities.map((item) => item.predicate.sql),
      `ORDER BY ${block.orderBy.map((order) => `${order.sql} ${order.direction}`).join(', ')}`,
      'The M6 row-value keyset boundary',
    ],
    expectedEffect:
      `Predicted/unverified: supply the requested order without sorting. OFFSET still requires visiting ${formatRows(block.offset)} preceding entries; the M6 cursor rewrite is required to avoid that discard work.`,
    priority: 1,
    confidence: 'high',
    costScope: 'keyset covering index',
  };
}

function nullableAntiJoinIndex(ir: QueryIR, root: QueryBlockIR): RecommendationSpec | undefined {
  const predicate = root.predicates.find((candidate) =>
    candidate.kind === 'subquery' && candidate.negated && /\bNOT\s+IN\s*\(/i.test(candidate.sql),
  );
  const child = predicate && nestedBlockIds(predicate).map((id) => ir.blocks.find((block) => block.id === id)).find(Boolean);
  const output = child?.projections[0]?.columns[0];
  const relation = child?.relations.find((candidate) => candidate.alias === output?.alias);
  if (!child || !output?.nullable || !output.alias || !relation?.source) return undefined;
  const filters = child.predicates.filter((candidate) =>
    candidate.clause === 'where' && candidate.columns.every((column) => column.alias === output.alias),
  );
  if (filters.some((filter) => /\$\d+/.test(filter.sql))) return undefined;
  const whereParts = filters.map((filter) => removeQualifier(filter.sql, output.alias));
  whereParts.push(`${quoteIdentifier(output.column)} IS NOT NULL`);
  return {
    purpose: 'not-exists-partial',
    table: relation.source,
    keys: [output.column],
    method: 'btree',
    where: whereParts.join(' AND '),
    rationale:
      `Fixed subquery filters and NULL exclusion belong in the partial predicate; ${output.column} is the correlated anti-join equality key.`,
    serves: [`The M6 NOT EXISTS correlation on ${refSql(output)}`, ...filters.map((filter) => filter.sql)],
    expectedEffect:
      'Predicted/unverified: this index does not repair or accelerate the current wrong NOT IN semantics. After the M6 NOT EXISTS correctness rewrite, it can provide a compact non-NULL anti-join input.',
    priority: 1,
    confidence: 'high',
    costScope: 'rewrite-coupled partial anti-join index',
  };
}

function existenceJoinIndexes(block: QueryBlockIR): RecommendationSpec[] {
  const specs: RecommendationSpec[] = [];
  const selective = block.predicates
    .filter((predicate) =>
      predicate.clause === 'where' &&
      predicate.kind === 'equality' &&
      predicate.selectivity !== undefined && predicate.selectivity <= 0.2 &&
      predicate.columns.length === 1,
    )
    .sort((a, b) => (a.selectivity ?? 1) - (b.selectivity ?? 1))[0];
  const filteredRef = selective && singleColumn(selective);
  if (!selective || !filteredRef?.alias || !filteredRef.table) return specs;
  const bridgeJoin = block.joins.find((join) =>
    join.equiKeys.some((key) => key.left.alias === filteredRef.alias || key.right.alias === filteredRef.alias),
  );
  const bridgeKey = bridgeJoin?.equiKeys.find((key) =>
    key.left.alias === filteredRef.alias || key.right.alias === filteredRef.alias,
  );
  if (!bridgeJoin || !bridgeKey) return specs;
  const filteredJoinRef = bridgeKey.left.alias === filteredRef.alias ? bridgeKey.left : bridgeKey.right;
  const otherRef = bridgeKey.left.alias === filteredRef.alias ? bridgeKey.right : bridgeKey.left;
  if (!otherRef.alias || !otherRef.table) return specs;

  const otherJoinColumns = unique(block.joins.flatMap((join) => join.equiKeys.flatMap((key) => [key.left, key.right]))
    .filter((ref) => ref.alias === otherRef.alias && ref.column !== otherRef.column)
    .map((ref) => ref.column));
  specs.push({
    purpose: 'existence-bridge-cover',
    table: otherRef.table,
    keys: [otherRef.column],
    include: otherJoinColumns.slice(0, 2),
    method: 'btree',
    rationale:
      `${otherRef.column} is the equality probe from the selective ${filteredRef.table} side; ${otherJoinColumns.length ? `${otherJoinColumns.slice(0, 2).join(', ')} are payload passed to the next join.` : 'no payload is required.'}`,
    serves: [joinKeySql(bridgeKey), 'The equivalent joined path inside an M6 EXISTS semi-join'],
    expectedEffect:
      `Predicted/unverified: permit selective ${filteredRef.table} matches to probe ${otherRef.table} instead of scanning the full bridge relation. DISTINCT removal still requires the M6 EXISTS rewrite.`,
    priority: 1,
    confidence: 'high',
    costScope: 'high-row-count bridge index',
  });

  specs.push({
    purpose: 'selective-filter-cover',
    table: filteredRef.table,
    keys: [filteredRef.column],
    include: [filteredJoinRef.column],
    method: 'btree',
    rationale: `${filteredRef.column} is the selective equality key; ${filteredJoinRef.column} is payload for the bridge probe.`,
    serves: [selective.sql, joinKeySql(bridgeKey)],
    expectedEffect:
      `Predicted/unverified: narrow ${filteredRef.table} to the catalog-estimated ${formatSelectivity(selective.selectivity)} matching subset and provide its join key. This small-side index is secondary to the bridge index.`,
    priority: 3,
    confidence: 'medium',
    costScope: 'selective-side covering index',
  });
  return specs;
}

function rawCastRangeIndex(
  catalog: Catalog,
  block: QueryBlockIR,
  findings: Finding[],
): RecommendationSpec | undefined {
  const finding = firstFinding(findings, 'non-sargable-cast-on-column');
  const predicate = predicateForFinding(block, finding);
  const ref = predicate && singleColumn(predicate);
  if (!predicate || !ref?.table || !isDateCastRange(predicate.sql)) return undefined;
  const table = findTable(catalog, ref.table);
  const column = findColumn(catalog, ref.table, ref.column);
  if (!table || (table.rowCount ?? 0) < 10_000) return undefined;
  const correlation = Math.abs(column?.stats?.correlation ?? 0);
  const useBrin = correlation >= 0.8 && (table.rowCount ?? 0) >= 100_000;
  return {
    purpose: useBrin ? 'raw-range-brin' : 'raw-range-btree',
    table: ref.table,
    keys: [ref.column],
    method: useBrin ? 'brin' : 'btree',
    withOptions: useBrin ? 'pages_per_range = 32, autosummarize = on' : undefined,
    rationale: useBrin
      ? `${ref.column} is the raw range key and has catalog correlation ${correlation.toFixed(2)}; BRIN can summarize physically adjacent time ranges at far lower storage cost than a full B-tree.`
      : `${ref.column} is the raw range key; catalog correlation is insufficient to assume BRIN block elimination, so a B-tree is the conservative path.`,
    serves: [`The M6 raw half-open range replacing ${predicate.sql}`],
    expectedEffect:
      `Predicted/unverified: no useful effect while the WHERE clause casts ${ref.column}. After the raw-column rewrite, provide a ${useBrin ? 'lossy block-range bitmap' : 'bounded B-tree'} access path.`,
    priority: 1,
    confidence: useBrin ? 'high' : 'medium',
    costScope: 'rewrite-coupled raw time-range index',
  };
}

function topPerGroupIndex(ir: QueryIR, catalog: Catalog, root: QueryBlockIR): RecommendationSpec | undefined {
  const child = ir.blocks.find((block) =>
    block.correlated && block.aggregates.length === 1 && ['max', 'min'].includes(block.aggregates[0]!.func.toLowerCase()),
  );
  const aggregate = child?.aggregates[0];
  const innerKey = child && innerCorrelationRef(child);
  const extremeProjection = child?.projections.find((projection) => projection.sql === aggregate?.sql);
  const extremeRef = extremeProjection?.columns[0];
  const innerRelation = child?.relations.find((relation) => relation.alias === innerKey?.alias);
  const outerAlias = child?.correlationRefs?.[0]?.alias;
  if (!child || !aggregate || !innerKey || !extremeRef || !innerRelation?.source || !outerAlias) return undefined;
  const keys = [innerKey.column, `${extremeRef.column} ${aggregate.func.toLowerCase() === 'max' ? 'DESC' : 'ASC'}`];
  const include = payloadColumns(root, catalog, outerAlias, keys, 3, innerRelation.source, false);
  return {
    purpose: 'top-per-group-cover',
    table: innerRelation.source,
    keys,
    include,
    method: 'btree',
    rationale:
      `${innerKey.column} groups adjacent entries; ${extremeRef.column} is ordered ${aggregate.func.toLowerCase() === 'max' ? 'descending' : 'ascending'} within each group. ${include.length ? `${include.join(', ')} are result payload and do not define order.` : ''}`,
    serves: [aggregate.sql, 'The M6 tie-preserving grouped-extreme join'],
    expectedEffect:
      'Predicted/unverified: make each current extreme probe stop at one entry and supply the setwise rewrite order/coverage. PostgreSQL 16 must not be described as skipping directly between groups.',
    priority: 1,
    confidence: 'high',
    costScope: 'wide top-per-group covering index',
  };
}

function jsonScalarIndex(block: QueryBlockIR, findings: Finding[]): RecommendationSpec | undefined {
  const finding = firstFinding(findings, 'unindexed-json-scalar-extraction');
  const jsonPredicate = predicateForFinding(block, finding);
  const jsonRef = jsonPredicate && singleColumn(jsonPredicate);
  if (!jsonPredicate || !jsonRef?.alias || !jsonRef.table) return undefined;
  const expression = jsonExtractionExpression(jsonPredicate.sql, jsonRef.alias);
  if (!expression) return undefined;
  const equalityFilters = block.predicates.filter((predicate) =>
    predicate !== jsonPredicate && predicate.clause === 'where' &&
    ['equality', 'in-list'].includes(predicate.kind) &&
    predicate.columns.length === 1 && predicate.columns[0]!.alias === jsonRef.alias &&
    predicate.selectivity !== undefined && predicate.selectivity <= 0.25 &&
    !/\$\d+/.test(predicate.sql),
  );
  const range = block.predicates.find((predicate) =>
    predicate.clause === 'where' && predicate.kind === 'range' &&
    predicate.columns.length === 1 && predicate.columns[0]!.alias === jsonRef.alias && predicate.sargable,
  );
  const rangeRef = range && singleColumn(range);
  const where = equalityFilters.length
    ? equalityFilters.map((predicate) => removeQualifier(predicate.sql, jsonRef.alias)).join(' AND ')
    : undefined;
  const distinctPayload = unique(block.projections
    .filter((projection) => /\bDISTINCT\b/i.test(projection.sql))
    .flatMap((projection) => projection.columns)
    .filter((column) => column.alias === jsonRef.alias)
    .map((column) => column.column));
  return {
    purpose: where ? 'json-scalar-partial-cover' : 'json-scalar-cover',
    table: jsonRef.table,
    keys: [`(${expression})`, ...(rangeRef ? [rangeRef.column] : [])],
    include: distinctPayload.slice(0, 2),
    method: 'btree',
    where,
    rationale:
      `${expression} is the equality expression and leads${rangeRef ? `; ${rangeRef.column} is the first range key` : ''}. ` +
      `${where ? 'The fixed selective predicates are represented as a partial predicate rather than redundant key columns. ' : ''}` +
      `${distinctPayload.length ? `${distinctPayload.slice(0, 2).join(', ')} is payload for the distinct aggregate.` : ''}`,
    serves: [jsonPredicate.sql, ...equalityFilters.map((predicate) => predicate.sql), ...(range ? [range.sql] : [])],
    expectedEffect:
      'Predicted/unverified: provide an exact B-tree expression equality path, optionally followed by a time range. A generic raw JSONB GIN index would serve different operators and is not substituted here.',
    priority: 1,
    confidence: where ? 'high' : 'medium',
    costScope: where ? 'partial expression covering index' : 'full expression index',
  };
}

// ---------------------------------------------------------------------------
// Materialization and shared facts
// ---------------------------------------------------------------------------

/** Index methods whose key columns accept an ASC/DESC modifier. */
const ORDERED_METHODS = new Set(['btree']);

/**
 * Everything PostgreSQL requires of an emitted definition, enforced at the one
 * point every recommendation passes through so no rule can bypass it.
 *
 * Returns a normalized spec, or `undefined` when the definition must not be
 * emitted at all. The split between those two outcomes is not cosmetic, and was
 * settled by running each shape against PostgreSQL 16.14 rather than by
 * reasoning about the manual:
 *
 *   Rejected — the server refuses the statement, so advice built on it is
 *   worthless and shipping it costs the reader a failed round trip:
 *     - a key or payload naming a column the table does not have
 *       ("column ... does not exist"), which is how a payload gathered from
 *       one relation ends up on another relation's index;
 *     - ASC/DESC on a payload column
 *       ("including column does not support ASC/DESC options");
 *     - ASC/DESC on a key under a method that has no ordering
 *       ("access method \"brin\" does not support ASC/DESC options").
 *
 *   Normalized — PostgreSQL *accepts* these and builds a real index, so
 *   dropping the recommendation would discard advice that is sound apart from
 *   one redundant column. Both merely waste storage and write bandwidth:
 *     - the same key column listed twice;
 *     - a payload column that is already a key.
 *
 * The audit that prompted this recorded all five as DDL PostgreSQL rejects.
 * Two of them it accepts; see docs/AUDIT-2026-08-03.md.
 */
export function validatedDefinition(
  catalog: Catalog,
  spec: AdviceIndexDefinition,
): { keys: string[]; include: string[] } | undefined {
  const table = findTable(catalog, spec.table);
  if (!table) return undefined;
  const ordered = ORDERED_METHODS.has(spec.method ?? 'btree');
  // An expression key carries its own parentheses and names no single column,
  // so column existence does not apply to it.
  const isExpression = (key: string) => /^\(.*\)$/.test(key.trim());
  const known = (column: string) => !!findColumn(catalog, spec.table, column);

  const keys: string[] = [];
  const seenKeys = new Set<string>();
  for (const key of spec.keys) {
    if (!isExpression(key)) {
      if (!known(baseKeyName(key))) return undefined;
      if (!ordered && /\s+(ASC|DESC)$/i.test(key.trim())) return undefined;
    }
    const identity = baseKeyName(key);
    if (seenKeys.has(identity)) continue;
    seenKeys.add(identity);
    keys.push(key);
  }
  if (!keys.length) return undefined;

  const include: string[] = [];
  const seenInclude = new Set<string>();
  for (const column of spec.include ?? []) {
    if (/\s+(ASC|DESC)$/i.test(column.trim())) return undefined;
    if (!known(column)) return undefined;
    const identity = column.toLowerCase();
    if (seenKeys.has(identity) || seenInclude.has(identity)) continue;
    seenInclude.add(identity);
    include.push(column);
  }

  return { keys, include };
}

function materializeRecommendation(catalog: Catalog, spec: RecommendationSpec): IndexRecommendation | undefined {
  const table = findTable(catalog, spec.table);
  if (!table || !spec.keys.length) return undefined;
  // A plain view has no storage, so CREATE INDEX on it is DDL PostgreSQL rejects.
  // Materialized views are physical and indexable, so they are not excluded.
  if (table.kind === 'view') return undefined;

  const validated = validatedDefinition(catalog, spec);
  if (!validated) return undefined;
  spec = { ...spec, keys: validated.keys, include: validated.include };
  if (hasEquivalentIndex(table.indexes, spec)) return undefined;

  const id = indexDefinitionAdviceId(spec);
  const indexName = physicalIndexName(id);
  const using = spec.method && spec.method !== 'btree' ? ` USING ${spec.method}` : '';
  const include = spec.include?.length
    ? ` INCLUDE (${spec.include.map(quoteIdentifier).join(', ')})`
    : '';
  const options = spec.withOptions ? ` WITH (${spec.withOptions})` : '';
  const where = spec.where ? ` WHERE ${spec.where}` : '';
  const ddl = `CREATE INDEX CONCURRENTLY ${indexName} ON ${qualifiedTable(catalog, spec.table)}${using} (${spec.keys.map(keySql).join(', ')})${include}${options}${where};`;
  const stored = [...spec.keys, ...(spec.include ?? [])];
  const rowNote = table.rowCount !== undefined ? `about ${formatRows(table.rowCount)} catalog-estimated rows` : 'an unknown number of rows';
  const partial = spec.where ? ` The partial predicate limits entries to rows satisfying ${spec.where}; its exact size is not measured.` : '';
  const brin = spec.method === 'brin'
    ? ' BRIN stores block summaries rather than one full key entry per row, but effectiveness and size depend on physical correlation and pages_per_range.'
    : ` A full definition can store up to one entry per row across ${rowNote}.`;
  const payload = spec.include?.length
    ? ` INCLUDE payload (${spec.include.join(', ')}) widens each eligible entry and is not a search key.`
    : '';
  const updateColumns = stored.map((key) => key.replace(/\s+(ASC|DESC)$/i, '')).join(', ');
  const redundant = table.indexes
    .filter((index) => sameKeyPrefix(index.columns, spec.keys))
    .map((index) => index.name);

  return {
    id,
    ddl,
    table: spec.table,
    columns: [...spec.keys],
    includeColumns: spec.include?.length ? [...spec.include] : undefined,
    method: spec.method as IndexRecommendation['method'],
    where: spec.where,
    columnOrderRationale: spec.rationale,
    serves: spec.serves,
    expectedEffect: spec.expectedEffect,
    cost: {
      estimatedSizeNote: `Size is unmeasured.${brin}${partial}${payload}`,
      writeImpact:
        `${spec.where ? 'Eligible inserts and rows entering/leaving the partial predicate' : 'Every insert'} plus updates to ${updateColumns} require index maintenance.` +
        (spec.include?.length ? ' Payload-only updates also write the index.' : '') +
        ` Validate this ${spec.costScope ?? 'index'} against workload frequency before deployment.`,
    },
    redundantWith: redundant.length ? redundant : undefined,
    priority: spec.priority,
    confidence: spec.confidence,
  };
}

/**
 * Payload columns for an index, drawn from what `alias` contributes to the
 * block's output and joins.
 *
 * `onTable` is the relation the index is actually built on. It is not always
 * the relation `alias` refers to: a correlated-extreme index keys the inner
 * relation while its payload serves the outer query. Columns are kept only when
 * they exist on `onTable`, because a payload naming a column of some other
 * relation is DDL PostgreSQL refuses outright. Restricting here rather than
 * rejecting downstream keeps the index itself, which is sound, and drops only
 * the columns that cannot belong to it.
 *
 * `filterByWidth` skips wide and toastable payload; it is disabled where the
 * caller has already decided the projection defines the payload.
 */
function payloadColumns(
  block: QueryBlockIR,
  catalog: Catalog,
  alias: string,
  keys: string[],
  max: number,
  onTable: string,
  filterByWidth = true,
): string[] {
  const keyNames = new Set(keys.map(baseKeyName));
  const candidates = unique([
    ...block.projections.flatMap((projection) => projection.columns),
    ...block.joins.flatMap((join) => join.equiKeys.flatMap((key) => [key.left, key.right])),
  ].filter((ref) => ref.alias === alias).map((ref) => ref.column));
  return candidates.filter((column) => {
    if (keyNames.has(column.toLowerCase())) return false;
    if (!findColumn(catalog, onTable, column)) return false;
    if (!filterByWidth) return true;
    const catalogColumn = findColumn(catalog, onTable, column);
    return !/jsonb|bytea/i.test(catalogColumn?.dataType ?? '') && (catalogColumn?.stats?.avgWidth ?? 0) <= 128;
  }).slice(0, max);
}

function literalEqualities(block: QueryBlockIR, alias: string): Array<{ predicate: Predicate; column: ResolvedColumnRef }> {
  return block.predicates.flatMap((predicate) => {
    const column = singleColumn(predicate);
    if (
      predicate.clause !== 'where' || predicate.kind !== 'equality' ||
      !predicate.sargable || column?.alias !== alias || /\$\d+/.test(predicate.sql)
    ) return [];
    return [{ predicate, column }];
  });
}

function predicateForFinding(block: QueryBlockIR, finding: Finding | undefined): Predicate | undefined {
  if (!finding) return undefined;
  return block.predicates.find((predicate) => sameSql(predicate.sql, finding.evidence.sqlFragment));
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

function innerCorrelationRef(block: QueryBlockIR): ResolvedColumnRef | undefined {
  const innerAliases = new Set(block.relations.map((relation) => relation.alias));
  return block.predicates.flatMap((predicate) => predicate.columns).find((ref) => ref.alias && innerAliases.has(ref.alias));
}

function orderingIsUnique(catalog: Catalog, tableName: string, columns: string[]): boolean {
  const table = findTable(catalog, tableName);
  if (!table) return false;
  const covers = (key: string[] | undefined) => !!key?.length && key.every((column) => columns.includes(column));
  return covers(table.primaryKey) || table.indexes.some((index) => index.unique && !index.where && covers(index.columns));
}

function hasEquivalentIndex(indexes: Table['indexes'], spec: RecommendationSpec): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/["\s]/g, '').replace(/asc$/i, '');
  return indexes.some((index) =>
    index.method === spec.method &&
    index.columns.length === spec.keys.length &&
    index.columns.every((column, position) => normalize(column) === normalize(spec.keys[position]!)) &&
    (index.includeColumns ?? []).length === (spec.include ?? []).length &&
    (index.includeColumns ?? []).every((column, position) => normalize(column) === normalize(spec.include![position]!)) &&
    normalize(index.where ?? '') === normalize(spec.where ?? ''),
  );
}

function sameKeyPrefix(existing: string[], proposed: string[]): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/["\s]/g, '').replace(/(asc|desc)$/i, '');
  const length = Math.min(existing.length, proposed.length);
  return length > 0 && existing.slice(0, length).every((key, index) => normalize(key) === normalize(proposed[index]!));
}

function baseKeyName(key: string): string {
  return key.replace(/\s+(ASC|DESC)$/i, '').replace(/^\(+|\)+$/g, '').toLowerCase();
}

function isMonthDateTrunc(sql: string): boolean {
  return /date_trunc\s*\(\s*'month'\s*,/i.test(sql) && /=\s*TIMESTAMPTZ\s*'/i.test(sql);
}

function isDateCastRange(sql: string): boolean {
  return /::\s*date\s+BETWEEN\s+DATE\s*'/i.test(sql);
}

function jsonExtractionExpression(sql: string, alias: string): string | undefined {
  const equality = /^(.+?)\s*=\s*(?:E)?'(?:''|[^'])*'(?:\s*::\s*\w+)?\s*$/i.exec(sql.trim());
  if (!equality || !/(?:->>|#>>)/.test(equality[1]!)) return undefined;
  return removeQualifier(equality[1]!, alias).replace(/^\(+|\)+$/g, '').trim();
}

function refSql(ref: ResolvedColumnRef): string {
  return `${ref.alias ? `${ref.alias}.` : ''}${ref.column}`;
}

function joinKeySql(key: QueryBlockIR['joins'][number]['equiKeys'][number]): string {
  return `${refSql(key.left)} = ${refSql(key.right)}`;
}

function formatRows(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatSelectivity(value: number | undefined): string {
  return value === undefined ? 'unknown fraction' : `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

function sameSql(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
