/**
 * M3 -- conservative offline execution prediction for PostgreSQL.
 *
 * Predictions come only from QueryIR and Catalog. No captured plan or runtime
 * artifact is read here, and every reason names uncertainty where the shared
 * catalog lacks the statistics needed for a categorical choice.
 */
import { distinctCount, findColumn, findTable } from '../catalog.ts';
import { indexesLeadingWith, rowsPerKey, uniqueOnColumns } from '../ir/catalog-facts.ts';
import { blockById, outerJoinDemotions } from '../ir/index.ts';
import type {
  AccessPath,
  Catalog,
  ExecutionAnalysis,
  IndexDef,
  JoinAlgorithm,
  JoinIR,
  Predicate,
  QueryBlockIR,
  QueryIR,
  RelationIR,
  ResolvedColumnRef,
  Table,
} from '../types.ts';

type Access = ExecutionAnalysis['accessPaths'][number];
type JoinStrategy = ExecutionAnalysis['joinStrategies'][number];
type DominantCost = ExecutionAnalysis['dominantCosts'][number];
type MemoryRisk = ExecutionAnalysis['memoryRisks'][number];
type EstimationRisk = ExecutionAnalysis['estimationRisks'][number];

interface WeightedCost {
  weight: number;
  cost: DominantCost;
}

interface PathDecision {
  path: AccessPath;
  index?: IndexDef;
  estimatedRows?: number;
  reason: string;
}

interface CorrelatedWork {
  block: QueryBlockIR;
  parent: QueryBlockIR;
  driverRows?: number;
  rowsPerLoop?: number;
  access?: Access;
}

export function predictExecution(ir: QueryIR, catalog: Catalog): ExecutionAnalysis {
  const root = blockById(ir, ir.rootBlockId) ?? ir.blocks[0];
  if (!root) return emptyExecution(ir);

  const accessPaths = predictAccessPaths(ir, catalog);
  const correlated = correlatedWork(ir, catalog, accessPaths);
  const ctx: EstimateContext = { catalog, demoted: new Set(outerJoinDemotions(ir).map((demotion) => demotion.join)) };
  const joinStrategies = predictJoinStrategies(ir, ctx, correlated);
  const dominantCosts = predictDominantCosts(ir, root, ctx, accessPaths, correlated);
  const memoryRisks = predictMemoryRisks(ctx, root);
  const estimationRisks = predictEstimationRisks(ir, root, catalog);
  const scalability = predictScalability(root, ir, catalog, correlated);

  return { accessPaths, joinStrategies, dominantCosts, memoryRisks, estimationRisks, scalability };
}

function emptyExecution(ir: QueryIR): ExecutionAnalysis {
  const error = ir.bindingErrors.find((item) => item.severity === 'error');
  return {
    accessPaths: [],
    joinStrategies: [],
    dominantCosts: error ? [{ what: 'Execution prediction is blocked', why: `The query could not be bound safely: ${error.message}` }] : [],
    memoryRisks: [],
    estimationRisks: error ? [{ where: 'the unbound statement', why: error.message, direction: 'unknown' }] : [],
    scalability: { summary: 'Scaling cannot be predicted until the statement has a bound result-producing block.' },
  };
}

function predictAccessPaths(ir: QueryIR, catalog: Catalog): Access[] {
  const out: Access[] = [];
  for (const block of ir.blocks) {
    for (const relation of block.relations) {
      const decision = decidePath(block, relation, catalog);
      out.push({
        relation: relationLabel(block, relation),
        path: decision.path,
        usingIndex: decision.index?.name,
        estimatedRows: decision.estimatedRows,
        reason: decision.reason,
      });
    }
  }
  return out;
}

function decidePath(block: QueryBlockIR, relation: RelationIR, catalog: Catalog): PathDecision {
  const table = findTable(catalog, relation.source);
  if (!table || relation.kind !== 'table') {
    return {
      path: 'unknown',
      estimatedRows: relation.estimatedRows,
      reason: `Offline prediction: ${code(relation.alias)} is ${relation.kind === 'table' ? 'not present in the catalog' : `a ${relation.kind} result whose physical access is chosen inside its producing block`}.`,
    };
  }

  const estimatedRows = relation.estimatedRows ?? (relation.localPredicates.length ? undefined : table.rowCount);
  const candidates = usablePredicateIndexes(relation, catalog);
  if (candidates.length) {
    const candidate = candidates[0]!;
    // GIN and BRIN have no ordered entries and no visibility-map support: both
    // reach the heap through a bitmap, and neither can drive an index-only
    // scan. Confirmed on PostgreSQL 16.14 (see METHOD_SERVES).
    const bitmapOnly = candidate.index.method === 'gin' || candidate.index.method === 'brin';
    const covered = !bitmapOnly && indexCoversBlock(candidate.index, block, relation.alias);
    const broad = candidate.predicate.kind === 'range' || candidate.predicate.kind === 'in-list' ||
      (estimatedRows !== undefined && table.rowCount !== undefined && estimatedRows / table.rowCount > 0.05);
    const path: AccessPath = covered
      ? 'index-only-scan'
      : bitmapOnly || (broad && (estimatedRows === undefined || estimatedRows > 5_000))
        ? 'bitmap-heap-scan'
        : 'index-scan';
    return {
      path,
      index: candidate.index,
      estimatedRows,
      reason: `${predictionPrefix(path)} ${code(candidate.predicate.sql)} can use leading key ${code(candidate.column.column)} of ${code(candidate.index.name)}.${
        covered
          ? ' Every referenced column in this block is stored by that index, although visibility-map coverage still decides whether heap visits are avoided.'
          : bitmapOnly
            ? ` A ${candidate.index.method.toUpperCase()} index has no ordered entries and no visibility-map support, so matches are collected into a bitmap and the heap is visited in physical order; an index-only path is not available.`
            : broad
              ? ' A bitmap path is plausible because the range or match count may touch many scattered heap rows; a simple index path remains possible at lower selectivity.'
              : ' The matching set appears selective enough for direct lookups, but the planner can still prefer a sequential read when the estimate grows.'
      }`,
    };
  }

  const ordered = orderSupplyingIndex(block, relation, table);
  if (ordered) {
    return {
      path: 'index-scan',
      index: ordered,
      estimatedRows,
      reason: `Offline prediction: scanning ${code(ordered.name)} can supply the requested ${naturalList(block.orderBy.map((item) => `${code(item.sql)} ${item.direction.toUpperCase()}`))} order without a separate top-level sort. All qualifying entries may still be visited, and projected columns can require heap access.`,
    };
  }

  const bulkPressure = bulkJoinPressure(block, relation, catalog);
  if (bulkPressure) {
    return {
      path: 'seq-scan',
      estimatedRows,
      reason: `Offline prediction: ${bulkPressure} Reading ${formatRows(table.rowCount, relation.source)} once for a bulk hash is more plausible than many lookups on another join key. A reordered live plan is still required to confirm the full chain.`,
    };
  }

  const lookup = joinLookupIndex(block, relation, catalog);
  if (lookup) {
    return {
      path: 'index-scan',
      index: lookup.index,
      estimatedRows: lookup.rowsPerLookup,
      reason: `Offline prediction: ${code(lookup.index.name)} is a plausible parameterized lookup on join key ${code(lookup.column)}${lookup.rowsPerLookup !== undefined ? `, emitting about ${formatEstimate(lookup.rowsPerLookup)} rows per driving value` : ''}. ${lookup.uncertain ? 'The driver selectivity is unknown, so a bulk sequential/hash alternative remains credible.' : 'The driving side is predicted to be small enough that repeated lookups are more plausible than reading this whole relation.'}`,
    };
  }

  const nonSargable = relation.localPredicates.filter((predicate) => !predicate.sargable);
  // An index can lead with the right column and still be unusable because its
  // method does not implement the operator — a hash index under a range test,
  // for one. Saying "no index begins with their referenced columns" there is
  // false and sends the reader off to create an index that already exists.
  const wrongMethod = mismatchedLeadingIndexes(relation, catalog);
  const reason = nonSargable.length
    ? `Offline prediction: no existing leading-key access path can evaluate ${naturalList(nonSargable.map((predicate) => code(predicate.sql)))} as a seek, so PostgreSQL is likely to read ${formatRows(table.rowCount, relation.source)} and apply the condition to rows. A live EXPLAIN is required to confirm parallelism.`
    : wrongMethod.length
      ? `Offline prediction: ${naturalList(wrongMethod.map(({ index, predicate }) => `${code(index.name)} leads with ${code(index.columns[0]!)} but is a ${index.method.toUpperCase()} index, which does not implement ${code(predicate.sql)}`))}. PostgreSQL cannot use ${wrongMethod.length > 1 ? 'those indexes' : 'that index'} for this condition and is likely to read ${formatRows(table.rowCount, relation.source)} instead. A method that supports this operator would be required, not merely an index on the same column.`
      : relation.localPredicates.length
        ? `Offline prediction: the row conditions are structurally seekable in isolation, but no existing index begins with their referenced columns. Reading ${formatRows(table.rowCount, relation.source)} is therefore the leading candidate.`
        : `Offline prediction: no local condition narrows ${code(relation.source)} and no small-driver lookup is established, so a sequential read of ${formatRows(table.rowCount, relation.source)} is the conservative candidate.`;
  return { path: 'seq-scan', estimatedRows, reason };
}

function bulkJoinPressure(block: QueryBlockIR, relation: RelationIR, catalog: Catalog): string | undefined {
  const table = findTable(catalog, relation.source);
  if (!table?.rowCount || table.rowCount < 500_000) return undefined;
  for (const join of block.joins) {
    for (const key of join.equiKeys) {
      const local = refForAlias(key, relation.alias);
      const other = key.left.alias === relation.alias ? key.right : key.left;
      if (!local || indexesLeadingWith(catalog, relation.source, local.column).length) continue;
      const otherRelation = block.relations.find((candidate) => candidate.alias === other.alias);
      const otherTable = otherRelation ? findTable(catalog, otherRelation.source) : undefined;
      const otherRows = relationRows(otherRelation, catalog);
      if (!otherTable?.rowCount || otherRows === undefined || otherRows / otherTable.rowCount > 0.02) continue;
      return `${code(otherRelation!.alias)} is narrowed to about ${formatEstimate(otherRows)} rows, but ${code(relation.source)} has no existing leading-key path on join column ${code(local.column)}.`;
    }
  }
  return undefined;
}

/**
 * Which predicate shapes each index method can actually answer.
 *
 * An index leading with the right column is not enough: the method has to
 * support the operator. Admitting only btree and hash, and never consulting the
 * predicate kind, produced claims in both directions — a hash index credited
 * with serving a range scan, which PostgreSQL answers with a sequential scan,
 * and a GIN index ignored for the containment operator it exists to serve, with
 * the report stating no index begins with that column when one does.
 *
 * Checked on PostgreSQL 16.14 against a 200k-row table (`EXPLAIN` node in
 * brackets):
 *   hash + `>`      -> Seq Scan; the index is not used at all
 *   hash + `=`      -> [Index Scan]
 *   hash + `IN`     -> [Bitmap Index Scan]; hash does serve ScalarArrayOp
 *   gin  + `@>`     -> [Bitmap Index Scan]
 *   brin + BETWEEN  -> [Bitmap Index Scan]
 *
 * GiST and SP-GiST entries are the conservative subset of what their standard
 * operator classes support; they were not exercised above, so nothing is
 * claimed for them beyond containment- and range-style operators.
 */
const METHOD_SERVES: Record<IndexDef['method'], Set<Predicate['kind']>> = {
  btree: new Set(['equality', 'in-list', 'range', 'like-prefix', 'null-check', 'join']),
  hash: new Set(['equality', 'in-list', 'join']),
  brin: new Set(['equality', 'range']),
  gin: new Set(['containment']),
  gist: new Set(['containment', 'range']),
  spgist: new Set(['containment', 'range', 'like-prefix']),
};

/**
 * Indexes that lead with a predicate's column but whose method cannot answer
 * it. These are the near misses worth naming: the reader has the column
 * indexed already, and needs to know the method is the problem.
 */
function mismatchedLeadingIndexes(
  relation: RelationIR,
  catalog: Catalog,
): Array<{ predicate: Predicate; index: IndexDef }> {
  const out: Array<{ predicate: Predicate; index: IndexDef }> = [];
  for (const predicate of relation.localPredicates) {
    if (!predicate.sargable) continue;
    const column = predicate.columns.find((item) => item.alias === relation.alias && item.table === relation.source);
    if (!column) continue;
    for (const index of indexesLeadingWith(catalog, relation.source, column.column)) {
      if (!METHOD_SERVES[index.method]?.has(predicate.kind)) out.push({ predicate, index });
    }
  }
  return out;
}

function usablePredicateIndexes(
  relation: RelationIR,
  catalog: Catalog,
): Array<{ predicate: Predicate; column: ResolvedColumnRef; index: IndexDef }> {
  const out: Array<{ predicate: Predicate; column: ResolvedColumnRef; index: IndexDef }> = [];
  for (const predicate of relation.localPredicates) {
    if (!predicate.sargable) continue;
    const column = predicate.columns.find((item) => item.alias === relation.alias && item.table === relation.source);
    if (!column) continue;
    for (const index of indexesLeadingWith(catalog, relation.source, column.column)) {
      if (!METHOD_SERVES[index.method]?.has(predicate.kind)) continue;
      out.push({ predicate, column, index });
    }
  }
  const rank: Record<Predicate['kind'], number> = {
    equality: 0, 'in-list': 1, range: 2, containment: 3, 'like-prefix': 4, join: 5,
    'null-check': 6, boolean: 7, subquery: 8, 'like-infix': 9, other: 10,
  };
  return out.sort((a, b) => rank[a.predicate.kind] - rank[b.predicate.kind]);
}

function indexCoversBlock(index: IndexDef, block: QueryBlockIR, alias: string): boolean {
  if (index.expressions?.length || index.where) return false;
  const stored = new Set([...index.columns, ...(index.includeColumns ?? [])]);
  const needed = blockColumns(block).filter((column) => column.alias === alias).map((column) => column.column);
  return needed.length > 0 && needed.every((column) => stored.has(column));
}

function blockColumns(block: QueryBlockIR): ResolvedColumnRef[] {
  return dedupeColumns([
    ...block.relations.flatMap((relation) => relation.localPredicates.flatMap((predicate) => predicate.columns)),
    ...block.predicates.flatMap((predicate) => predicate.columns),
    ...block.projections.flatMap((projection) => projection.columns),
    ...block.groupBy,
    ...block.orderBy.map((item) => item.column).filter(isDefined),
    ...block.windowFunctions.flatMap((window) => window.partitionBy),
  ]);
}

function orderSupplyingIndex(block: QueryBlockIR, relation: RelationIR, table: Table): IndexDef | undefined {
  if (!block.orderBy.length || block.orderBy.some((item) => !item.column || item.column.alias !== relation.alias)) return undefined;
  const columns = block.orderBy.map((item) => item.column!.column);
  return table.indexes.find((index) =>
    index.method === 'btree' && !index.where && columns.every((column, position) => index.columns[position] === column),
  );
}

function joinLookupIndex(
  block: QueryBlockIR,
  relation: RelationIR,
  catalog: Catalog,
): { index: IndexDef; column: string; rowsPerLookup?: number; uncertain: boolean } | undefined {
  for (const join of block.joins) {
    for (const key of join.equiKeys) {
      const local = [key.left, key.right].find((column) => column.alias === relation.alias);
      const other = [key.left, key.right].find((column) => column.alias !== relation.alias);
      if (!local || !other) continue;
      const index = indexesLeadingWith(catalog, relation.source, local.column).find((candidate) => candidate.method === 'btree');
      if (!index) continue;
      const otherRelation = block.relations.find((candidate) => candidate.alias === other.alias);
      const otherTable = otherRelation ? findTable(catalog, otherRelation.source) : undefined;
      const driverRows = otherRelation?.estimatedRows ?? (otherRelation?.localPredicates.length ? undefined : otherTable?.rowCount);
      const uncertain = driverRows === undefined;
      if (!uncertain && driverRows! > 100_000) continue;
      let perLookup = rowsPerKey(catalog, relation.source, [local.column]);
      for (const predicate of relation.localPredicates) {
        if (predicate.selectivity !== undefined && perLookup !== undefined) perLookup *= predicate.selectivity;
      }
      return { index, column: local.column, rowsPerLookup: perLookup, uncertain };
    }
  }
  return undefined;
}

function predictJoinStrategies(ir: QueryIR, ctx: EstimateContext, correlated: CorrelatedWork[]): JoinStrategy[] {
  const out: JoinStrategy[] = [];
  const demotions = outerJoinDemotions(ir);
  for (const block of ir.blocks) {
    for (const join of block.joins) {
      const left = block.relations.find((relation) => relation.alias === join.leftRelation);
      const right = block.relations.find((relation) => relation.alias === join.rightRelation);
      const leftRows = relationRows(left, ctx.catalog);
      const rightRows = relationRows(right, ctx.catalog);
      const algorithm = chooseJoinAlgorithm(block, join, left, right, leftRows, rightRows, ctx.catalog);
      const output = estimateJoinRows(ctx, block, join);
      const demotion = demotions.find((item) => item.blockId === block.id && item.join === join);
      out.push({
        join: `${join.leftRelation} ${join.type.toUpperCase()} ${join.rightRelation}${block.id === ir.rootBlockId ? '' : ` in ${block.id}`}`,
        algorithm: algorithm.algorithm,
        estimatedRows: output,
        reason: `${algorithm.reason}${join.equiKeys.length ? ` The equality keys are ${naturalList(join.equiKeys.map((key) => `${columnName(key.left)} = ${columnName(key.right)}`))}.` : ''}${demotion ? ` ${code(demotion.predicate.sql)} rejects NULL-extended rows, so PostgreSQL may execute this as an inner join; there is no outer-join execution barrier, although the result semantics remain an intent concern.` : ''}`,
      });
    }
  }

  for (const work of correlated) {
    const aggregate = work.block.aggregates[0]?.sql;
    out.push({
      join: `correlated subplan ${work.block.id}${aggregate ? ` (${aggregate})` : ''}`,
      algorithm: 'nested-loop',
      estimatedRows: work.driverRows,
      reason: `Offline prediction: the subplan references an outer row and is therefore expected to run once for each of ${work.driverRows === undefined ? 'an unknown number of' : `about ${formatEstimate(work.driverRows)}`} driver rows${work.rowsPerLoop === undefined ? '' : `, visiting about ${formatEstimate(work.rowsPerLoop)} inner rows per invocation`}. This is repeated parameterized work, not one independent execution.`,
    });
  }

  for (const item of findNullableNotIn(ir)) {
    const child = blockById(ir, item.childId);
    out.push({
      join: `nullable NOT IN subplan ${item.childId}`,
      algorithm: 'unknown',
      estimatedRows: child ? estimateBlockRows(ctx, child) : undefined,
      reason: `Offline prediction: PostgreSQL 16 is likely to build and probe a hashed membership SubPlan for ${code(item.predicate.sql)} when it fits memory. Because the child value can be NULL, this must not be described as a hash anti-join: one qualifying NULL can make all nonmatches unknown.`,
    });
  }
  return out;
}

function chooseJoinAlgorithm(
  block: QueryBlockIR,
  join: JoinIR,
  left: RelationIR | undefined,
  right: RelationIR | undefined,
  leftRows: number | undefined,
  rightRows: number | undefined,
  catalog: Catalog,
): { algorithm: JoinAlgorithm; reason: string } {
  if (!join.equiKeys.length) {
    return {
      algorithm: join.type === 'cross' || join.type === 'lateral' ? 'nested-loop' : 'unknown',
      reason: `Offline prediction: there is no equality key for a hash or merge join; PostgreSQL will likely use nested iteration for this ${join.type} shape, but row-dependent functions or residual conditions can change the choice.`,
    };
  }
  const rightKey = join.equiKeys.map((key) => key.right).find((column) => column.alias === right?.alias);
  const leftKey = join.equiKeys.map((key) => key.left).find((column) => column.alias === left?.alias);
  const rightIndex = right && rightKey ? indexesLeadingWith(catalog, right.source, rightKey.column).find((index) => index.method === 'btree') : undefined;
  const leftIndex = left && leftKey ? indexesLeadingWith(catalog, left.source, leftKey.column).find((index) => index.method === 'btree') : undefined;
  const leftFilteredUnknown = Boolean(left?.localPredicates.length && leftRows === undefined);
  const rightFilteredUnknown = Boolean(right?.localPredicates.length && rightRows === undefined);

  if (rightIndex && ((leftRows !== undefined && leftRows <= 100_000) || leftFilteredUnknown)) {
    return {
      algorithm: 'nested-loop',
      reason: `Offline prediction: ${code(left?.alias ?? 'the left input')} is selective or may be selective, and ${code(rightIndex.name)} can probe ${code(right?.alias ?? 'the right input')} per driver row. If the unknown filter is broad, a hash join remains a credible alternative.`,
    };
  }
  if (leftIndex && ((rightRows !== undefined && rightRows <= 100_000) || rightFilteredUnknown)) {
    return {
      algorithm: 'nested-loop',
      reason: join.type === 'inner'
        ? `Offline prediction: PostgreSQL can reorder this inner-compatible join and probe ${code(leftIndex.name)} from the smaller or filtered ${code(right?.alias ?? 'right')} input. A bulk hash remains possible if that input is broader than estimated.`
        : `Offline prediction: PostgreSQL can probe ${code(leftIndex.name)} from the smaller or filtered ${code(right?.alias ?? 'right')} input while preserving the ${join.type.toUpperCase()} JOIN semantics. A bulk hash remains possible if that input is broader than estimated.`,
    };
  }
  if (leftRows !== undefined && rightRows !== undefined && (leftRows > 100_000 || rightRows > 100_000)) {
    return {
      algorithm: 'hash-join',
      reason: `Offline prediction: joining roughly ${formatEstimate(leftRows)} and ${formatEstimate(rightRows)} input rows favors one bulk read and an in-memory hash over many random probes. Hash batching and parallelism require a live plan to confirm.`,
    };
  }
  return {
    algorithm: 'unknown',
    reason: 'Offline prediction: missing range/selectivity information leaves the nested-loop versus hash crossover unresolved. A selective driver favors indexed probes; a broad driver favors a bulk hash.',
  };
}

function correlatedWork(ir: QueryIR, catalog: Catalog, accessPaths: Access[]): CorrelatedWork[] {
  const out: CorrelatedWork[] = [];
  for (const block of ir.blocks.filter((candidate) => candidate.correlated)) {
    const parent = parentBlock(ir, block.id);
    if (!parent) continue;
    const driverRows = driverRowsBeforeSubplan(parent, block.id, catalog);
    const localRelation = block.relations[0];
    const correlation = block.predicates.find((predicate) => predicate.kind === 'join' && predicate.columns.some((column) => column.alias === localRelation?.alias));
    const localColumn = correlation?.columns.find((column) => column.alias === localRelation?.alias);
    const perLoop = localRelation && localColumn ? rowsPerKey(catalog, localRelation.source, [localColumn.column]) : undefined;
    const access = accessPaths.find((path) => path.relation === relationLabel(block, localRelation));
    out.push({ block, parent, driverRows, rowsPerLoop: perLoop, access });
  }
  return out;
}

function parentBlock(ir: QueryIR, childId: string): QueryBlockIR | undefined {
  return ir.blocks.find((block) =>
    block.predicates.some((predicate) => (predicate.subqueryBlockIds ?? []).includes(childId)) ||
    block.projections.some((projection) => (projection.subqueryBlockIds ?? []).includes(childId)),
  );
}

function driverRowsBeforeSubplan(parent: QueryBlockIR, childId: string, catalog: Catalog): number | undefined {
  if (parent.relations.length !== 1) return estimateBlockInputRows({ catalog, demoted: new Set() }, parent);
  const relation = parent.relations[0]!;
  const table = findTable(catalog, relation.source);
  let rows = table?.rowCount;
  if (rows === undefined) return undefined;
  const predicates = relation.localPredicates.filter((predicate) => !(predicate.subqueryBlockIds ?? []).includes(childId));
  for (const predicate of predicates) {
    if (predicate.selectivity === undefined) return relation.estimatedRows;
    rows *= predicate.selectivity;
  }
  return Math.max(0, Math.round(rows));
}

function predictDominantCosts(
  ir: QueryIR,
  root: QueryBlockIR,
  ctx: EstimateContext,
  accessPaths: Access[],
  correlated: CorrelatedWork[],
): DominantCost[] {
  const { catalog } = ctx;
  const costs: WeightedCost[] = [];

  for (const path of accessPaths) {
    if (path.path !== 'seq-scan') continue;
    const located = locateRelation(ir, path.relation);
    const table = located ? findTable(catalog, located.relation.source) : undefined;
    if (!table?.rowCount) continue;
    const expressionWork = located!.relation.localPredicates.some((predicate) => !predicate.sargable) ? 1.25 : 1;
    costs.push({
      weight: table.rowCount * expressionWork,
      cost: {
        what: `Read and test ${located!.relation.source}`,
        why: `Offline prediction: the likely sequential path must inspect approximately ${formatEstimate(table.rowCount)} rows${expressionWork > 1 ? ' and evaluate row-level expressions that lack a usable seek condition' : ''}. Output limits do not avoid this work unless another access path can produce qualifying rows in order.`,
      },
    });
  }

  for (const work of correlated) {
    const loops = work.driverRows;
    const inner = work.rowsPerLoop;
    const aggregate = work.block.aggregates[0];
    const heapFactor = aggregate?.func === 'count' && work.access?.path === 'index-only-scan' ? 2 : 12;
    const weight = (loops ?? 10_000) * (inner ?? 10) * heapFactor;
    costs.push({
      weight,
      cost: {
        what: `Repeat ${aggregate?.sql ?? `subplan ${work.block.id}`} for each driver row`,
        why: `Offline prediction: the correlated work is invoked ${loops === undefined ? 'once per outer row' : `about ${formatEstimate(loops)} times`}${inner === undefined ? '' : ` and revisits about ${formatEstimate(inner)} inner rows each time`}. Per-invocation work must be multiplied by the loop count; ${work.access?.path === 'index-only-scan' ? 'the covering path can reduce heap visits but does not remove repetition' : 'heap-backed lookups and aggregation make the repetition significant'}.`,
      },
    });
  }

  const joinEstimates = root.joins.map((join) => ({ join, rows: estimateJoinRows(ctx, root, join) }));
  for (const item of joinEstimates) {
    if (item.rows === undefined || item.rows < 10_000) continue;
    const fanOut = item.join.multipliedRelations?.length
      ? ` The join repeats ${naturalList(item.join.multipliedRelations.map(code))}; downstream aggregation or duplicate removal pays for every repeated row.`
      : '';
    costs.push({
      weight: item.rows * (item.join.fanOut ? 2 : 1),
      cost: {
        what: `Process the ${item.join.leftRelation}-${item.join.rightRelation} join stream`,
        why: `Offline prediction: catalog keys, row counts, and available selectivities imply roughly ${formatEstimate(item.rows)} joined rows.${fanOut} The exact join order and parallel shape require EXPLAIN.`,
      },
    });
  }

  const inputRows = estimateBlockInputRows(ctx, root);
  if (root.aggregates.length || root.groupBy.length) {
    const countDistinct = root.aggregates.some((aggregate) => aggregate.distinct);
    costs.push({
      weight: (inputRows ?? largestRelationRows(root, catalog) ?? 10_000) * (countDistinct ? 2.5 : 1.5),
      cost: {
        what: countDistinct ? 'Group rows and deduplicate aggregate inputs' : 'Group and aggregate the joined input',
        why: `Offline prediction: every qualifying${root.joins.some((join) => join.fanOut) ? ' and join-expanded' : ''} row must reach aggregation${countDistinct ? ', while each distinct aggregate also removes repeated non-NULL values' : ''}. ${inputRows === undefined ? 'The catalog cannot derive the complete input count, so the planner strategy and magnitude remain uncertain.' : `The structural estimate is about ${formatEstimate(inputRows)} rows before grouping.`}`,
      },
    });
  }

  if (root.distinct) {
    const rows = inputRows ?? largestRelationRows(root, catalog);
    costs.push({
      weight: (rows ?? 10_000) * 1.5,
      cost: {
        what: 'Remove duplicate projected rows',
        why: `Offline prediction: DISTINCT operates after the joins and therefore processes the expanded input, not just the final unique rows. ${rows === undefined ? 'Cross-table duplicate density is unavailable.' : `Up to roughly ${formatEstimate(rows)} candidate rows may reach this stage before collapse.`}`,
      },
    });
  }

  if (root.orderBy.length) {
    const orderedByIndex = root.relations.some((relation) => {
      const table = findTable(catalog, relation.source);
      return table ? Boolean(orderSupplyingIndex(root, relation, table)) : false;
    });
    if (!orderedByIndex) {
      const candidates = rowsBeforeOrdering(ctx, root) ?? inputRows ?? largestRelationRows(root, catalog) ?? 10_000;
      const retained = root.limit !== undefined ? (root.offset ?? 0) + root.limit : candidates;
      const bounded = root.limit !== undefined;
      if (candidates > 100 || retained > 100) {
        costs.push({
          weight: candidates * Math.log2(Math.max(2, retained)) * (bounded ? 0.25 : 0.6),
          cost: {
            what: bounded ? `Maintain the best ${formatEstimate(retained)} ordered candidates` : 'Order all result candidates',
            why: `Offline prediction: no existing ordering path covers the requested keys. ${bounded ? `PostgreSQL can use bounded top-N work, but OFFSET raises N to ${formatEstimate(retained)} rather than ${formatEstimate(root.limit!)} and all qualifying rows still compete.` : 'A full sort or an order-aware aggregate is required; the exact strategy depends on the planner.'}`,
          },
        });
      }
    }
  }

  if (root.offset) {
    costs.push({
      weight: root.offset * 2,
      cost: {
        what: `Produce and discard ${formatEstimate(root.offset)} rows`,
        why: `Offline prediction: OFFSET cannot return the requested page until at least ${formatEstimate(root.offset)} earlier ordered rows have been produced. This work grows directly with page depth.`,
      },
    });
  }

  return dedupeDominant(costs)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 6)
    .map((item) => item.cost);
}

function predictMemoryRisks(ctx: EstimateContext, root: QueryBlockIR): MemoryRisk[] {
  const { catalog } = ctx;
  const risks: MemoryRisk[] = [];
  const workMem = parseMemoryBytes(catalog.settings?.work_mem);

  for (const join of root.joins) {
    if (!join.equiKeys.length) continue;
    const left = root.relations.find((relation) => relation.alias === join.leftRelation);
    const right = root.relations.find((relation) => relation.alias === join.rightRelation);
    const candidates = [left, right].filter(isDefined).map((relation) => ({
      relation,
      rows: relationRows(relation, catalog),
      width: relationWidth(relation, catalog),
    })).filter((item) => item.rows !== undefined && item.width !== undefined);
    if (!candidates.length || workMem === undefined) continue;
    const build = candidates.sort((a, b) => a.rows! * a.width! - b.rows! * b.width!)[0]!;
    const bytes = build.rows! * build.width! * 2;
    if (bytes <= workMem * 1.5) continue;
    risks.push({
      operation: `Possible hash build for ${join.leftRelation}-${join.rightRelation}`,
      why: `The smaller known input is roughly ${formatBytes(bytes)} including a conservative hash overhead estimate, above work_mem ${formatBytes(workMem)}. PostgreSQL may use hash_mem_multiplier, parallel/shared memory, or batching; this is memory pressure to verify, not a claim that the current plan writes temporary data.`,
    });
  }

  const distinctAggregate = root.aggregates.find((aggregate) => aggregate.distinct);
  if (distinctAggregate && estimateBlockInputRows(ctx, root) === undefined) {
    risks.push({
      operation: `Distinct-state work for ${distinctAggregate.sql}`,
      why: `Memory grows with qualifying non-NULL inputs, but expression/date/multicolumn selectivity is missing from the catalog. A broader match set can exceed per-operation work_mem; no current spill is asserted without a plan.`,
    });
  }

  if (root.distinct && estimateBlockInputRows(ctx, root) === undefined) {
    risks.push({
      operation: 'DISTINCT over join output',
      why: 'Memory grows with pre-deduplication join rows rather than final unique rows. Cross-table duplicate density is unavailable, so a live plan is needed before claiming either in-memory execution or temporary I/O.',
    });
  }

  return dedupeBy(risks, (risk) => risk.operation);
}

function predictEstimationRisks(ir: QueryIR, root: QueryBlockIR, catalog: Catalog): EstimationRisk[] {
  const risks: EstimationRisk[] = [];
  for (const block of ir.blocks) {
    for (const relation of block.relations) {
      if (!relation.localPredicates.length || relation.estimatedRows !== undefined) continue;
      const missing = relation.localPredicates.filter((predicate) => predicate.selectivity === undefined);
      if (!missing.length) continue;
      const expressions = missing.filter((predicate) => !predicate.sargable || predicate.columns.some((column) => /jsonb|timestamp with time zone/i.test(column.dataType ?? '')));
      risks.push({
        where: `${relationLabel(block, relation)} row conditions`,
        why: `${naturalList(missing.map((predicate) => code(predicate.sql)))} lacks a complete selectivity estimate in the exported catalog.${expressions.length ? ' Expression, date-range, JSON, LIKE, and correlated-subquery distributions require expression/histogram or multivariate statistics that are not present.' : ''}`,
        direction: 'unknown',
      });
    }
  }

  for (const item of findNullableNotIn(ir)) {
    risks.push({
      where: `outer rows after ${code(item.predicate.sql)}`,
      why: 'The catalog gives overall nullability but not whether NULL occurs inside the filtered subquery population. One qualifying NULL can change the outer result from many rows to zero, so a percentage estimate is not trustworthy.',
      direction: 'unknown',
    });
  }

  if (root.joins.some((join) => join.fanOut)) {
    risks.push({
      where: 'join fan-out and downstream group cardinality',
      why: 'Single-column row counts and distinct counts do not describe correlation between filters and per-key child counts. The average multiplier is useful for scale, but the filtered fan-out and number of surviving groups can differ materially.',
      direction: 'unknown',
    });
  }

  if (root.distinct) {
    risks.push({
      where: 'rows remaining after DISTINCT',
      why: 'The catalog does not encode how many multi-table join paths collapse to the same projected identity. Treating columns or joins as independent commonly overstates final unique rows.',
      direction: 'over',
    });
  }

  const distinctAggregate = root.aggregates.find((aggregate) => aggregate.distinct);
  if (distinctAggregate) {
    risks.push({
      where: `distinct values contributing to ${code(distinctAggregate.sql)}`,
      why: 'The distinct count of the full column does not reveal how many different non-NULL values survive the query\'s other conditions. Correlation between those filters and the counted value is not represented.',
      direction: 'unknown',
    });
  }

  if (root.having.some((predicate) => predicate.columns.length === 0 || /\b(count|sum|avg|min|max)\s*\(/i.test(predicate.sql))) {
    risks.push({
      where: 'groups remaining after aggregate HAVING conditions',
      why: 'Base-column statistics do not describe the distribution of per-group aggregate values, so the fraction of groups passing the aggregate condition is weakly supported.',
      direction: 'unknown',
    });
  }

  const expressionGroups = (root.groupByExpressions ?? []).filter((expression) => /::\s*date\b|->>|\w+\s*\(/i.test(expression.sql));
  if (expressionGroups.length) {
    risks.push({
      where: 'number of expression-based groups',
      why: `No expression statistics are represented for ${naturalList(expressionGroups.map((expression) => code(expression.sql)))}. Written filters can impose a much tighter group bound than the planner's generic expression distinct count.`,
      direction: 'over',
    });
  }

  for (const work of correlatedWork(ir, catalog, [])) {
    if (!work.block.aggregates.some((aggregate) => aggregate.func === 'max' || aggregate.func === 'min')) continue;
    const predicate = work.parent.predicates.find((candidate) => (candidate.subqueryBlockIds ?? []).includes(work.block.id));
    if (!predicate) continue;
    risks.push({
      where: `outer rows passing correlated ${work.block.aggregates[0]!.func} equality`,
      why: 'Ordinary column statistics do not encode how many rows equal their per-group extreme or how many rows tie there. A generic equality estimate can substantially understate the returned rows.',
      direction: 'under',
    });
  }

  return dedupeBy(risks, (risk) => `${risk.where}\u0000${risk.direction}`);
}

function predictScalability(
  root: QueryBlockIR,
  ir: QueryIR,
  catalog: Catalog,
  correlated: CorrelatedWork[],
): ExecutionAnalysis['scalability'] {
  const parts: string[] = [];
  const terms: string[] = [];
  const seqRelations = root.relations.filter((relation) => decidePath(root, relation, catalog).path === 'seq-scan');
  if (seqRelations.length) {
    parts.push(`work grows linearly with all rows read from ${naturalList(seqRelations.map((relation) => code(relation.source)))}, even when few rows qualify`);
    terms.push('N_read');
  }
  if (root.offset) {
    parts.push(`position-based pagination adds work proportional to page depth ${formatEstimate(root.offset)}`);
    terms.push('depth');
  }
  if (root.joins.some((join) => join.fanOut)) {
    parts.push('join and downstream aggregation/deduplication work grows with the number of matching child rows, not just final rows');
    terms.push('fanout');
  }
  if (root.aggregates.some((aggregate) => aggregate.distinct) || root.distinct) {
    parts.push('duplicate removal grows with pre-deduplication matches and may add sorting or hashing');
    terms.push('M log M');
  }
  if (!seqRelations.length && (root.aggregates.length || root.groupBy.length)) {
    parts.push('aggregation grows with qualifying rows and the number of groups rather than necessarily with the entire base table');
    terms.push('R_matching');
    terms.push('G');
  }
  if (correlated.length) {
    const selfCorrelated = correlated.some((work) => work.block.relations.some((inner) => work.parent.relations.some((outer) => inner.source === outer.source)));
    parts.push(selfCorrelated
      ? 'a correlated self-lookup repeats per outer row; with k rows per key its tuple work grows like the sum of k squared across keys'
      : 'correlated subplans repeat once per driver row and again for each matching inner row');
    terms.push(selfCorrelated ? 'Σk²' : 'N_outer × k_inner');
  }
  if (!parts.length) {
    parts.push('work is output-sensitive and otherwise follows the rows read from its base relations');
    terms.push('N');
  }
  return {
    summary: `Offline prediction: ${capitalize(naturalList(parts))}. Live EXPLAIN is required to calibrate constants, parallelism, cache behavior, and any spill.`,
    complexity: `O(${unique(terms).join(' + ')})`,
  };
}

interface EstimateContext {
  catalog: Catalog;
  /** Outer joins whose null-extension is proven eliminated by a WHERE predicate. */
  demoted: ReadonlySet<JoinIR>;
}

/**
 * Estimate the rows a join emits. The base arithmetic models an inner join; a
 * LEFT/RIGHT/FULL join then preserves every preserved-side row even when the
 * other side matches only a fraction of rows, so the estimate is floored at the
 * preserved side's cardinality. A null-rejected (demoted) outer join is not
 * floored: the WHERE predicate already eliminated the null-extended rows.
 */
function estimateJoinRows(ctx: EstimateContext, block: QueryBlockIR, join: JoinIR): number | undefined {
  const { catalog } = ctx;
  const left = block.relations.find((relation) => relation.alias === join.leftRelation);
  const right = block.relations.find((relation) => relation.alias === join.rightRelation);
  if (!left || !right) return undefined;
  const leftRows = relationRows(left, catalog);
  const rightRows = relationRows(right, catalog);
  const leftTable = findTable(catalog, left.source);
  const rightTable = findTable(catalog, right.source);
  const key = join.equiKeys[0];

  let estimate: number | undefined;
  if (key && leftTable && rightTable) {
    const leftUnique = uniqueOnColumns(catalog, left.source, join.equiKeys.map((item) => refForAlias(item, left.alias)?.column).filter(isDefined)).unique;
    const rightUnique = uniqueOnColumns(catalog, right.source, join.equiKeys.map((item) => refForAlias(item, right.alias)?.column).filter(isDefined)).unique;

    if (rightUnique && leftRows !== undefined) {
      const rightFraction = filteredFraction(right, rightTable);
      if (!right.localPredicates.length || rightFraction !== undefined) estimate = leftRows * (rightFraction ?? 1);
    } else if (leftUnique && rightRows !== undefined) {
      const leftFraction = filteredFraction(left, leftTable);
      if (!left.localPredicates.length || leftFraction !== undefined) estimate = rightRows * (leftFraction ?? 1);
    } else {
      const rightFk = foreignKeyReferences(rightTable, leftTable, join, right.alias, left.alias);
      if (rightFk && leftRows !== undefined && leftTable.rowCount && rightTable.rowCount) {
        const fraction = filteredFraction(right, rightTable);
        if (!right.localPredicates.length || fraction !== undefined) estimate = leftRows * (rightTable.rowCount / leftTable.rowCount) * (fraction ?? 1);
      } else {
        const leftFk = foreignKeyReferences(leftTable, rightTable, join, left.alias, right.alias);
        if (leftFk && rightRows !== undefined && rightTable.rowCount && leftTable.rowCount) {
          const fraction = filteredFraction(left, leftTable);
          if (!left.localPredicates.length || fraction !== undefined) estimate = rightRows * (leftTable.rowCount / rightTable.rowCount) * (fraction ?? 1);
        }
      }
    }
  }

  if (estimate !== undefined) return roundEstimate(applyOuterJoinFloor(ctx, join, estimate, leftRows, rightRows));

  // The inner-match cardinality is unknowable, but a non-demoted outer join
  // still emits every preserved-side row — a provable lower bound.
  if (ctx.demoted.has(join)) return undefined;
  if (join.type === 'left' && leftRows !== undefined) return roundEstimate(leftRows);
  if (join.type === 'right' && rightRows !== undefined) return roundEstimate(rightRows);
  if (join.type === 'full') {
    const sides = [leftRows, rightRows].filter(isDefined);
    if (sides.length) return roundEstimate(Math.max(...sides));
  }
  return undefined;
}

function applyOuterJoinFloor(ctx: EstimateContext, join: JoinIR, estimate: number, leftRows: number | undefined, rightRows: number | undefined): number {
  if (ctx.demoted.has(join)) return estimate;
  switch (join.type) {
    case 'left':
      return Math.max(estimate, leftRows ?? estimate);
    case 'right':
      return Math.max(estimate, rightRows ?? estimate);
    case 'full':
      return Math.max(estimate, leftRows ?? estimate, rightRows ?? estimate);
    default:
      return estimate;
  }
}

function estimateBlockInputRows(ctx: EstimateContext, block: QueryBlockIR): number | undefined {
  if (!block.joins.length) return relationRows(block.relations[0], ctx.catalog);
  const estimates = block.joins.map((join) => estimateJoinRows(ctx, block, join));
  return estimates.at(-1) ?? estimates.filter(isDefined).at(-1);
}

function estimateBlockRows(ctx: EstimateContext, block: QueryBlockIR): number | undefined {
  if (block.groupBy.length) {
    const counts = block.groupBy.map((column) => column.table ? distinctCount(ctx.catalog, column.table, column.column) : undefined).filter(isDefined);
    if (counts.length === block.groupBy.length) return Math.min(product(counts), estimateBlockInputRows(ctx, block) ?? Infinity);
  }
  if (block.aggregates.length) return 1;
  return estimateBlockInputRows(ctx, block);
}

function estimateOutputRows(ctx: EstimateContext, block: QueryBlockIR): number | undefined {
  if (block.aggregates.length && !block.groupBy.length && !block.groupByExpressions?.length) return 1;
  const groups = block.groupByExpressions ?? [];
  if (groups.length) {
    if (groups.every((expression) => groupExpressionFixed(block, expression))) return 1;
    const dayBound = boundedDateGroupCount(block);
    if (dayBound !== undefined) return dayBound;
  }
  if (block.groupBy.length) {
    for (const relation of block.relations) {
      const table = findTable(ctx.catalog, relation.source);
      if (!table?.primaryKey?.length || !table.rowCount) continue;
      const grouped = new Set(block.groupBy.filter((column) => column.alias === relation.alias).map((column) => column.column));
      if (table.primaryKey.every((column) => grouped.has(column))) {
        return Math.min(table.rowCount, estimateBlockInputRows(ctx, block) ?? table.rowCount);
      }
    }
    const counts = block.groupBy.map((column) => column.table ? distinctCount(ctx.catalog, column.table, column.column) : undefined);
    if (counts.every(isDefined)) return Math.min(product(counts), estimateBlockInputRows(ctx, block) ?? Infinity);
  }
  return block.limit ?? estimateBlockInputRows(ctx, block);
}

function rowsBeforeOrdering(ctx: EstimateContext, block: QueryBlockIR): number | undefined {
  if (block.aggregates.length || block.groupBy.length || block.groupByExpressions?.length || block.distinct) {
    return estimateOutputRows(ctx, block);
  }
  return estimateBlockInputRows(ctx, block);
}

function groupExpressionFixed(block: QueryBlockIR, expression: NonNullable<QueryBlockIR['groupByExpressions']>[number]): boolean {
  const sql = expression.ordinal === undefined ? expression.sql : block.projections[expression.ordinal - 1]?.sql;
  if (!sql) return false;
  // Exact expression match: `date_trunc('month', o.created_at) = <constant>`.
  if (predicatePinsConstant(block, sql)) return true;
  // A bare-column group also matches qualified/unqualified spellings, provided
  // the group depends on that single column.
  if (expression.columns.length === 1) return columnPinnedByConstant(block, expression.columns[0]!);
  return false;
}

function predicatePinsConstant(block: QueryBlockIR, group: string): boolean {
  const target = normalizeSql(group.replace(/`/g, ''));
  return block.predicates.some((predicate) => {
    const operands = predicate.equalityOperands;
    if (predicate.kind !== 'equality' || !operands) return false;
    return (normalizeSql(operands.left) === target && operands.rightConstant)
        || (normalizeSql(operands.right) === target && operands.leftConstant);
  });
}

function columnPinnedByConstant(block: QueryBlockIR, column: ResolvedColumnRef): boolean {
  if (!column.alias && !column.table) return false;
  return block.predicates.some((predicate) => {
    const operands = predicate.equalityOperands;
    if (predicate.kind !== 'equality' || !operands) return false;
    if (operands.rightConstant && operandIsColumn(predicate, operands.left, column)) return true;
    if (operands.leftConstant && operandIsColumn(predicate, operands.right, column)) return true;
    return false;
  });
}

function operandIsColumn(predicate: Predicate, operandSql: string, column: ResolvedColumnRef): boolean {
  const op = normalizeSql(operandSql);
  const forms = [
    column.alias ? `${column.alias}.${column.column}` : null,
    column.table ? `${column.table}.${column.column}` : null,
    column.column,
  ].filter((form): form is string => form !== null).map(normalizeSql);
  if (!forms.includes(op)) return false;
  return predicate.columns.some((ref) => ref.column === column.column
    && (ref.alias ?? '') === (column.alias ?? '') && (ref.table ?? '') === (column.table ?? ''));
}

function boundedDateGroupCount(block: QueryBlockIR): number | undefined {
  if (!(block.groupByExpressions ?? []).some((expression) => /::\s*date\b/i.test(expression.sql))) return undefined;
  const predicate = block.predicates.find((item) => /\bBETWEEN\s+DATE\s*'\d{4}-\d{2}-\d{2}'\s+AND\s+DATE\s*'\d{4}-\d{2}-\d{2}'/i.test(item.sql));
  const match = predicate?.sql.match(/\bBETWEEN\s+DATE\s*'(\d{4}-\d{2}-\d{2})'\s+AND\s+DATE\s*'(\d{4}-\d{2}-\d{2})'/i);
  if (!match) return undefined;
  const first = Date.parse(`${match[1]}T00:00:00Z`);
  const last = Date.parse(`${match[2]}T00:00:00Z`);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last < first) return undefined;
  return Math.floor((last - first) / 86_400_000) + 1;
}

function relationRows(relation: RelationIR | undefined, catalog: Catalog): number | undefined {
  if (!relation) return undefined;
  if (relation.estimatedRows !== undefined) return relation.estimatedRows;
  if (relation.localPredicates.length) return undefined;
  return findTable(catalog, relation.source)?.rowCount;
}

function filteredFraction(relation: RelationIR, table: Table): number | undefined {
  if (!relation.localPredicates.length) return 1;
  let fraction = 1;
  for (const predicate of relation.localPredicates) {
    if (predicate.selectivity === undefined) return undefined;
    fraction *= predicate.selectivity;
  }
  if (relation.estimatedRows !== undefined && table.rowCount) return relation.estimatedRows / table.rowCount;
  return fraction;
}

function foreignKeyReferences(child: Table, parent: Table, join: JoinIR, childAlias: string, parentAlias: string): boolean {
  return Boolean(child.foreignKeys?.some((fk) => {
    if (fk.referencesTable !== parent.name) return false;
    return fk.columns.every((column, index) => join.equiKeys.some((key) => {
      const childRef = refForAlias(key, childAlias);
      const parentRef = refForAlias(key, parentAlias);
      return childRef?.column === column && parentRef?.column === fk.referencesColumns[index];
    }));
  }));
}

function refForAlias(key: JoinIR['equiKeys'][number], alias: string): ResolvedColumnRef | undefined {
  return key.left.alias === alias ? key.left : key.right.alias === alias ? key.right : undefined;
}

function findNullableNotIn(ir: QueryIR): Array<{ predicate: Predicate; childId: string }> {
  const out: Array<{ predicate: Predicate; childId: string }> = [];
  for (const block of ir.blocks) {
    for (const predicate of block.predicates) {
      if (!predicate.negated || !/\bNOT\s+IN\b/i.test(predicate.sql)) continue;
      for (const childId of predicate.subqueryBlockIds ?? []) {
        const child = blockById(ir, childId);
        if (child?.projections.some((projection) => projection.columns.some((column) => column.nullable !== false))) out.push({ predicate, childId });
      }
    }
  }
  return out;
}

function locateRelation(ir: QueryIR, label: string): { block: QueryBlockIR; relation: RelationIR } | undefined {
  for (const block of ir.blocks) {
    const relation = block.relations.find((candidate) => relationLabel(block, candidate) === label);
    if (relation) return { block, relation };
  }
  return undefined;
}

function largestRelationRows(block: QueryBlockIR, catalog: Catalog): number | undefined {
  const rows = block.relations.map((relation) => findTable(catalog, relation.source)?.rowCount).filter(isDefined);
  return rows.length ? Math.max(...rows) : undefined;
}

function relationWidth(relation: RelationIR, catalog: Catalog): number | undefined {
  const table = findTable(catalog, relation.source);
  if (!table) return undefined;
  const widths = table.columns.map((column) => column.stats?.avgWidth).filter(isDefined);
  return widths.length ? widths.reduce((sum, width) => sum + width, 0) + 24 : undefined;
}

function parseMemoryBytes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(kB|MB|GB|B)?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'B').toLowerCase();
  const factor = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  return amount * factor;
}

function predictionPrefix(path: AccessPath): string {
  const names: Record<AccessPath, string> = {
    'seq-scan': 'Offline prediction: a sequential read is likely.',
    'index-scan': 'Offline prediction: a direct index path is likely.',
    'index-only-scan': 'Offline prediction: a covering index path is plausible.',
    'bitmap-heap-scan': 'Offline prediction: a bitmap heap path is the leading candidate.',
    unknown: 'Offline prediction is uncertain.',
  };
  return names[path];
}

function relationLabel(block: QueryBlockIR, relation: RelationIR | undefined): string {
  if (!relation) return `${block.id}:unknown`;
  return block.id === 'main' ? relation.alias : `${relation.alias} (${block.id})`;
}

function columnName(column: ResolvedColumnRef): string {
  return `${column.alias ?? column.table ?? '?'}.${column.column}`;
}

function dedupeColumns(columns: ResolvedColumnRef[]): ResolvedColumnRef[] {
  const seen = new Set<string>();
  return columns.filter((column) => {
    const key = `${column.alias ?? column.table ?? ''}\u0000${column.column}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDominant(costs: WeightedCost[]): WeightedCost[] {
  const best = new Map<string, WeightedCost>();
  for (const item of costs) {
    const previous = best.get(item.cost.what);
    if (!previous || previous.weight < item.weight) best.set(item.cost.what, item);
  }
  return [...best.values()];
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function formatRows(rows: number | undefined, relation: string): string {
  return rows === undefined ? `an unknown number of ${code(relation)} rows` : `approximately ${formatEstimate(rows)} ${code(relation)} rows`;
}

function formatEstimate(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return rounded.toLocaleString('en-US');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Math.round(bytes / 1024).toLocaleString('en-US')} KiB`;
}

function roundEstimate(value: number): number {
  return Math.max(0, Math.round(value));
}

function product(values: number[]): number {
  return values.reduce((result, value) => result * value, 1);
}

function naturalList(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function code(value: string): string {
  return `\`${value}\``;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, '').replace(/[()]/g, '').toLowerCase();
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== undefined && value !== null;
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
}
