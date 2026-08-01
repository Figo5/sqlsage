/**
 * Normalize saved PostgreSQL `EXPLAIN (FORMAT JSON)` output and apply its
 * observed facts to an existing SQLSage analysis.
 *
 * This module deliberately does not execute SQL. It accepts already-captured
 * evidence only, and it keeps plan-only estimates distinct from measurements.
 */
import { readFileSync } from 'node:fs';

import type {
  AccessPath,
  Analysis,
  ExecutionAnalysis,
  JoinAlgorithm,
} from './types.ts';

type JsonObject = Record<string, unknown>;

export type PlanEvidenceMode = 'analyzed' | 'plan-only';

export class PlanInputError extends Error {
  readonly code: 'PLAN_INPUT_INVALID' | 'PLAN_INPUT_READ_FAILED';

  constructor(
    message: string,
    code: 'PLAN_INPUT_INVALID' | 'PLAN_INPUT_READ_FAILED' = 'PLAN_INPUT_INVALID',
  ) {
    super(message);
    this.name = 'PlanInputError';
    this.code = code;
  }
}

export interface NormalizedPlanNode {
  nodeType: string;
  depth: number;
  relation?: string;
  schema?: string;
  alias?: string;
  indexName?: string;
  joinType?: string;
  planRows?: number;
  actualRows?: number;
  actualLoops?: number;
  totalCost?: number;
  actualTotalMs?: number;
  filter?: string;
  indexCondition?: string;
  tempReadBlocks?: number;
  tempWrittenBlocks?: number;
  diskUsageKb?: number;
  sortMethod?: string;
  sortSpaceType?: string;
  sortSpaceKb?: number;
  children: NormalizedPlanNode[];
}

export interface ObservedAccessPath {
  relation: string;
  schema?: string;
  alias?: string;
  path: AccessPath;
  nodeType: string;
  usingIndex?: string;
  estimatedRows?: number;
  actualRows?: number;
  actualLoops?: number;
}

export interface ObservedJoin {
  algorithm: JoinAlgorithm;
  nodeType: string;
  joinType?: string;
  estimatedRows?: number;
  actualRows?: number;
  actualLoops?: number;
}

export interface RowEstimateRatio {
  nodeType: string;
  relation?: string;
  estimatedRows: number;
  actualRows: number;
  actualLoops: number;
  /** Actual rows per loop divided by planned rows per loop. */
  ratio: number;
  /** Symmetric magnitude when finite; absent when the observed row count is zero. */
  factor?: number;
  direction: 'under' | 'over' | 'accurate';
}

export interface PlanSpill {
  nodeType: string;
  relation?: string;
  reason: string;
  tempReadBlocks: number;
  tempWrittenBlocks: number;
  diskUsageKb?: number;
  sortSpaceKb?: number;
}

export interface PlanEvidenceSummary {
  nodeTypes: string[];
  relations: string[];
  accessPaths: ObservedAccessPath[];
  indexNames: string[];
  joins: ObservedJoin[];
  rowEstimateRatios: RowEstimateRatio[];
  spills: PlanSpill[];
  /** Query-level buffer counters are cumulative, so these are maxima, not sums. */
  tempIo: { readBlocks: number; writtenBlocks: number };
  planningMs?: number;
  executionMs?: number;
}

export interface PlanEvidence {
  mode: PlanEvidenceMode;
  /** The unwrapped PostgreSQL document containing `Plan`. */
  document: JsonObject;
  root: NormalizedPlanNode;
  nodes: NormalizedPlanNode[];
  summary: PlanEvidenceSummary;
  /** Present when supplied by a SQLSage evidence/ground-truth bundle. */
  sql?: string;
  /** Preserved for callers; this module does not interpret the catalog. */
  catalog?: unknown;
}

interface UnwrappedPlan {
  document: JsonObject;
  sql?: string;
  catalog?: unknown;
  bundleExecutionMs?: number;
  bundlePlanningMs?: number;
}

/**
 * Accept a PostgreSQL JSON array, a `{ Plan: ... }` document, or a SQLSage
 * evidence bundle containing `planJson`.
 */
export function normalizePlanEvidence(input: unknown): PlanEvidence {
  const unwrapped = unwrapInput(input);
  const rawRoot = requireObject(unwrapped.document.Plan, 'Plan must be an object.');
  const root = normalizeNode(rawRoot, 0, 'Plan');
  const nodes = flatten(root);

  const topExecutionMs = optionalNumber(unwrapped.document['Execution Time'], 'Execution Time');
  const topPlanningMs = optionalNumber(unwrapped.document['Planning Time'], 'Planning Time');
  const hasActualFields = nodes.some((node) =>
    node.actualRows !== undefined || node.actualLoops !== undefined || node.actualTotalMs !== undefined,
  );
  const mode: PlanEvidenceMode = topExecutionMs !== undefined || hasActualFields ? 'analyzed' : 'plan-only';
  const executionMs = mode === 'analyzed'
    ? topExecutionMs ?? unwrapped.bundleExecutionMs ?? root.actualTotalMs
    : undefined;
  const planningMs = topPlanningMs ?? unwrapped.bundlePlanningMs;

  return {
    mode,
    document: unwrapped.document,
    root,
    nodes,
    summary: summarize(nodes, planningMs, executionMs, mode),
    sql: unwrapped.sql,
    catalog: unwrapped.catalog,
  };
}

/** Read and normalize a saved JSON plan file. */
export function loadPlanEvidence(filePath: string): PlanEvidence {
  let source: string;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PlanInputError(`Could not read plan file: ${detail}`, 'PLAN_INPUT_READ_FAILED');
  }
  return normalizePlanEvidence(source);
}

/**
 * Return a new Analysis whose execution section prefers captured plan facts.
 * Only baseline evidence is attached. This function never invents an optimized
 * plan or a result-equivalence verdict.
 */
export function applyPlanEvidence(analysis: Analysis, evidence: PlanEvidence): Analysis {
  const execution = executionFromEvidence(analysis.execution, evidence);
  const verification: NonNullable<Analysis['verification']> = {
    ...(analysis.verification ?? {}),
    baselinePlan: evidence.document,
  };
  if (evidence.mode === 'analyzed' && evidence.summary.executionMs !== undefined) {
    verification.baselineMs = evidence.summary.executionMs;
  }

  return { ...analysis, execution, verification };
}

function unwrapInput(input: unknown): UnwrappedPlan {
  if (typeof input === 'string') {
    try {
      return unwrapInput(JSON.parse(input));
    } catch (error) {
      if (error instanceof PlanInputError) throw error;
      throw new PlanInputError('Plan input is not valid JSON.');
    }
  }

  if (Array.isArray(input)) {
    if (input.length !== 1) {
      throw new PlanInputError('PostgreSQL plan JSON must contain exactly one statement.');
    }
    return unwrapInput(input[0]);
  }

  const object = requireObject(
    input,
    'Plan input must be a PostgreSQL JSON plan or a SQLSage evidence bundle.',
  );

  if (Object.prototype.hasOwnProperty.call(object, 'planJson')) {
    const nested = unwrapInput(object.planJson);
    const sql = object.sql === undefined
      ? nested.sql
      : requireString(object.sql, 'Evidence bundle sql must be a string.');
    return {
      ...nested,
      sql,
      catalog: object.catalog ?? nested.catalog,
      bundleExecutionMs: optionalNumber(object.executionMs, 'executionMs') ?? nested.bundleExecutionMs,
      bundlePlanningMs: optionalNumber(object.planningMs, 'planningMs') ?? nested.bundlePlanningMs,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(object, 'Plan')) {
    throw new PlanInputError('Plan input is missing the top-level Plan object.');
  }
  return { document: object };
}

function normalizeNode(raw: JsonObject, depth: number, location: string): NormalizedPlanNode {
  const nodeType = requireString(raw['Node Type'], `${location}.Node Type must be a string.`);
  const childrenRaw = raw.Plans;
  if (childrenRaw !== undefined && !Array.isArray(childrenRaw)) {
    throw new PlanInputError(`${location}.Plans must be an array.`);
  }

  const children = (childrenRaw ?? []).map((child, index) =>
    normalizeNode(requireObject(child, `${location}.Plans[${index}] must be an object.`), depth + 1, `${location}.Plans[${index}]`),
  );

  return {
    nodeType,
    depth,
    relation: optionalString(raw['Relation Name'], `${location}.Relation Name`),
    schema: optionalString(raw.Schema, `${location}.Schema`),
    alias: optionalString(raw.Alias, `${location}.Alias`),
    indexName: optionalString(raw['Index Name'], `${location}.Index Name`),
    joinType: optionalString(raw['Join Type'], `${location}.Join Type`),
    planRows: optionalNumber(raw['Plan Rows'], `${location}.Plan Rows`),
    actualRows: optionalNumber(raw['Actual Rows'], `${location}.Actual Rows`),
    actualLoops: optionalNumber(raw['Actual Loops'], `${location}.Actual Loops`),
    totalCost: optionalNumber(raw['Total Cost'], `${location}.Total Cost`),
    actualTotalMs: optionalNumber(raw['Actual Total Time'], `${location}.Actual Total Time`),
    filter: optionalString(raw.Filter, `${location}.Filter`),
    indexCondition: optionalString(raw['Index Cond'], `${location}.Index Cond`),
    tempReadBlocks: optionalNumber(raw['Temp Read Blocks'], `${location}.Temp Read Blocks`),
    tempWrittenBlocks: optionalNumber(raw['Temp Written Blocks'], `${location}.Temp Written Blocks`),
    diskUsageKb: optionalNumber(raw['Disk Usage'], `${location}.Disk Usage`),
    sortMethod: optionalString(raw['Sort Method'], `${location}.Sort Method`),
    sortSpaceType: optionalString(raw['Sort Space Type'], `${location}.Sort Space Type`),
    sortSpaceKb: optionalNumber(raw['Sort Space Used'], `${location}.Sort Space Used`),
    children,
  };
}

function flatten(root: NormalizedPlanNode): NormalizedPlanNode[] {
  const out: NormalizedPlanNode[] = [];
  const visit = (node: NormalizedPlanNode) => {
    out.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return out;
}

function summarize(
  nodes: NormalizedPlanNode[],
  planningMs: number | undefined,
  executionMs: number | undefined,
  mode: PlanEvidenceMode,
): PlanEvidenceSummary {
  const accessPaths = nodes.flatMap((node): ObservedAccessPath[] => {
    const path = accessPath(node.nodeType);
    const relation = node.relation ?? (path !== 'unknown' ? node.alias : undefined);
    if (!relation || !isScan(node.nodeType)) return [];
    return [{
      relation,
      schema: node.schema,
      alias: node.alias,
      path,
      nodeType: node.nodeType,
      usingIndex: node.indexName ?? firstDescendantIndex(node),
      estimatedRows: node.planRows,
      actualRows: node.actualRows,
      actualLoops: node.actualLoops,
    }];
  });
  const joins = nodes.flatMap((node): ObservedJoin[] => {
    const algorithm = joinAlgorithm(node.nodeType);
    if (algorithm === undefined) return [];
    return [{
      algorithm,
      nodeType: node.nodeType,
      joinType: node.joinType,
      estimatedRows: node.planRows,
      actualRows: node.actualRows,
      actualLoops: node.actualLoops,
    }];
  });
  const rowEstimateRatios = mode === 'analyzed'
    ? nodes.flatMap(rowEstimateRatio)
    : [];
  const spills = nodes.flatMap(spillForNode);

  return {
    nodeTypes: unique(nodes.map((node) => node.nodeType)),
    relations: unique(accessPaths.map((path) => path.relation)),
    accessPaths,
    indexNames: unique(nodes.flatMap((node) => node.indexName ? [node.indexName] : [])),
    joins,
    rowEstimateRatios,
    spills,
    // Buffer values are inclusive through the tree. Taking the largest value
    // avoids counting the same temporary I/O once per ancestor.
    tempIo: {
      readBlocks: Math.max(0, ...nodes.map((node) => node.tempReadBlocks ?? 0)),
      writtenBlocks: Math.max(0, ...nodes.map((node) => node.tempWrittenBlocks ?? 0)),
    },
    planningMs,
    executionMs,
  };
}

function executionFromEvidence(predicted: ExecutionAnalysis, evidence: PlanEvidence): ExecutionAnalysis {
  const { summary } = evidence;
  const modeLabel = evidence.mode === 'analyzed' ? 'EXPLAIN ANALYZE' : 'plan-only EXPLAIN';
  const accessPaths = summary.accessPaths.map((access) => ({
    relation: access.alias && access.alias !== access.relation
      ? `${access.relation} (${access.alias})`
      : access.relation,
    path: access.path,
    usingIndex: access.usingIndex,
    // Keep the shared contract honest: this field is the planner estimate.
    // Observed rows remain explicit in the reason and normalized evidence.
    estimatedRows: access.estimatedRows,
    reason: `Observed in the saved ${modeLabel}: PostgreSQL used ${humanNode(access.nodeType)}${access.usingIndex ? ` with ${access.usingIndex}` : ''}${rowObservation(access, evidence.mode)}.`,
  }));
  const joinStrategies = summary.joins.map((join, index) => ({
    join: `${join.joinType ? `${join.joinType.toLowerCase()} ` : ''}join ${index + 1}`,
    algorithm: join.algorithm,
    estimatedRows: join.estimatedRows,
    reason: `Observed in the saved ${modeLabel}: PostgreSQL used ${humanNode(join.nodeType)}${rowObservation(join, evidence.mode)}.`,
  }));
  const ranked = [...evidence.nodes]
    .filter((node) => node.actualTotalMs !== undefined || node.totalCost !== undefined)
    .sort((left, right) => evidence.mode === 'analyzed'
      ? (right.actualTotalMs ?? -1) - (left.actualTotalMs ?? -1)
      : (right.totalCost ?? -1) - (left.totalCost ?? -1))
    .slice(0, 3);
  const dominantCosts = ranked.map((node) => ({
    what: `Observed ${node.nodeType}${node.relation ? ` on ${node.relation}` : ''}`,
    why: evidence.mode === 'analyzed'
      ? `The saved analyzed plan reports ${formatMs(node.actualTotalMs)} inclusive time for this node${node.actualLoops !== undefined ? ` across ${formatNumber(node.actualLoops)} loop(s)` : ''}; parent and child times overlap.`
      : `This node has total planner cost ${formatNumber(node.totalCost)}. Cost units rank work inside this plan; they are not milliseconds or a measured runtime.`,
  }));
  const observedMemoryRisks = summary.spills.map((spill) => ({
    operation: `${spill.nodeType}${spill.relation ? ` on ${spill.relation}` : ''}`,
    why: `The saved ${modeLabel} records ${spill.reason}`,
  }));
  const observedEstimationRisks = summary.rowEstimateRatios
    .filter((item) => item.factor === undefined || item.factor >= 2)
    .map((item) => ({
      where: `${item.nodeType}${item.relation ? ` on ${item.relation}` : ''}`,
      why: item.actualRows === 0
        ? `The saved analyzed plan estimated ${formatNumber(item.estimatedRows)} row(s) per loop and observed none.`
        : `The saved analyzed plan estimated ${formatNumber(item.estimatedRows)} row(s) per loop and observed ${formatNumber(item.actualRows)} (${formatNumber(item.factor)}x ${item.direction === 'under' ? 'more' : 'fewer'} than estimated).`,
      direction: item.direction === 'accurate' ? 'unknown' as const : item.direction,
    }));

  return {
    accessPaths,
    joinStrategies,
    dominantCosts,
    memoryRisks: evidence.mode === 'analyzed' ? observedMemoryRisks : [...observedMemoryRisks, ...predicted.memoryRisks],
    estimationRisks: evidence.mode === 'analyzed' ? observedEstimationRisks : predicted.estimationRisks,
    scalability: {
      summary: `The saved ${modeLabel} establishes the observed plan shape (${summary.nodeTypes.join(', ')}), but one capture does not establish growth at other data volumes. ${predicted.scalability.summary}`,
      complexity: predicted.scalability.complexity,
    },
  };
}

function accessPath(nodeType: string): AccessPath {
  switch (nodeType.toLowerCase()) {
    case 'seq scan':
      return 'seq-scan';
    case 'index scan':
      return 'index-scan';
    case 'index only scan':
      return 'index-only-scan';
    case 'bitmap heap scan':
      return 'bitmap-heap-scan';
    default:
      return 'unknown';
  }
}

function isScan(nodeType: string): boolean {
  return /(?:scan|search)$/i.test(nodeType) && !/^bitmap index scan$/i.test(nodeType);
}

function joinAlgorithm(nodeType: string): JoinAlgorithm | undefined {
  switch (nodeType.toLowerCase()) {
    case 'nested loop':
      return 'nested-loop';
    case 'hash join':
      return 'hash-join';
    case 'merge join':
      return 'merge-join';
    default:
      return undefined;
  }
}

function firstDescendantIndex(node: NormalizedPlanNode): string | undefined {
  for (const child of node.children) {
    if (child.indexName) return child.indexName;
    const nested = firstDescendantIndex(child);
    if (nested) return nested;
  }
  return undefined;
}

function rowEstimateRatio(node: NormalizedPlanNode): RowEstimateRatio[] {
  if (node.planRows === undefined || node.planRows <= 0 || node.actualRows === undefined) return [];
  const loops = node.actualLoops ?? 1;
  const ratio = node.actualRows / node.planRows;
  const tolerance = 1.1;
  return [{
    nodeType: node.nodeType,
    relation: node.relation,
    estimatedRows: node.planRows,
    actualRows: node.actualRows,
    actualLoops: loops,
    ratio,
    factor: ratio === 0 ? undefined : Math.max(ratio, 1 / ratio),
    direction: ratio > tolerance ? 'under' : ratio < 1 / tolerance ? 'over' : 'accurate',
  }];
}

function spillForNode(node: NormalizedPlanNode): PlanSpill[] {
  const tempReadBlocks = node.tempReadBlocks ?? 0;
  const tempWrittenBlocks = node.tempWrittenBlocks ?? 0;
  const diskSort = node.sortSpaceType?.toLowerCase() === 'disk' || /external/i.test(node.sortMethod ?? '');
  const diskUsage = node.diskUsageKb ?? 0;
  if (!tempReadBlocks && !tempWrittenBlocks && !diskSort && !diskUsage) return [];

  const facts: string[] = [];
  if (diskSort) facts.push(`a disk-backed ${node.sortMethod ?? 'sort'}`);
  if (diskUsage) facts.push(`${formatNumber(diskUsage)} kB of operator disk usage`);
  if (tempReadBlocks || tempWrittenBlocks) {
    facts.push(`${formatNumber(tempReadBlocks)} temporary block(s) read and ${formatNumber(tempWrittenBlocks)} written`);
  }
  return [{
    nodeType: node.nodeType,
    relation: node.relation,
    reason: `${facts.join(', ')}.`,
    tempReadBlocks,
    tempWrittenBlocks,
    diskUsageKb: node.diskUsageKb,
    sortSpaceKb: diskSort ? node.sortSpaceKb : undefined,
  }];
}

function rowObservation(
  value: { estimatedRows?: number; actualRows?: number; actualLoops?: number },
  mode: PlanEvidenceMode,
): string {
  if (mode === 'analyzed' && value.actualRows !== undefined) {
    return `, returning ${formatNumber(value.actualRows)} row(s) per loop${value.actualLoops !== undefined ? ` over ${formatNumber(value.actualLoops)} loop(s)` : ''}`;
  }
  return value.estimatedRows === undefined ? '' : `, with ${formatNumber(value.estimatedRows)} planned row(s)`;
}

function humanNode(nodeType: string): string {
  return nodeType.replace(/\b\w/g, (letter) => letter.toLowerCase());
}

function formatMs(value: number | undefined): string {
  return value === undefined ? 'no node timing' : `${formatNumber(value)} ms`;
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return 'unknown';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 }).format(value);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new PlanInputError(`${label} must be a non-negative finite number.`);
  }
  return value;
}

function requireObject(value: unknown, message: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlanInputError(message);
  }
  return value as JsonObject;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new PlanInputError(message);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new PlanInputError(`${label} must be a string.`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
